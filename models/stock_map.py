from collections import defaultdict

from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError

SHAPE_KINDS = [
    ('rack', 'Rack'),
    ('pallet', 'Pallet'),
    ('zone', 'Zone'),
    ('aisle', 'Aisle'),
    ('wall', 'Wall'),
    ('door', 'Door'),
    ('text', 'Label'),
]
# Only these hold stock
STOCK_KINDS = ('rack', 'pallet', 'zone')
SHAPE_FIELDS = ('kind', 'label', 'location_id', 'x', 'y', 'width', 'height')


class StockMap(models.Model):
    """Plan of a warehouse: one or more floors, each a grid of shapes linked to its locations."""

    _name = 'tricasia.stock.map'
    _description = 'Warehouse Map'

    warehouse_id = fields.Many2one('stock.warehouse', required=True, ondelete='cascade')
    company_id = fields.Many2one(related='warehouse_id.company_id', store=True)
    name = fields.Char(string='Name', related='warehouse_id.name')
    floor_ids = fields.One2many('tricasia.stock.map.floor', 'map_id', string='Floors')
    shape_ids = fields.One2many('tricasia.stock.map.shape', 'map_id', string='Shapes', readonly=True)

    _warehouse_uniq = models.Constraint('unique(warehouse_id)', 'A warehouse has a single map.')

    # ----------------------------------------------------------
    # Screen API
    # ----------------------------------------------------------

    @api.model
    def load_map(self, warehouse_id=False):
        """Everything the map screen needs for a warehouse (the first one when none is given)."""
        warehouses = self.env['stock.warehouse'].search([('company_id', 'in', self.env.companies.ids)])
        warehouse = warehouses.filtered(lambda w: w.id == warehouse_id) or warehouses[:1]
        stock_map = self.search([('warehouse_id', '=', warehouse.id)], limit=1) if warehouse else self
        locations = self.env['stock.location'].search([
            ('id', 'child_of', warehouse.view_location_id.id), ('usage', '=', 'internal'),
        ]) if warehouse else self.env['stock.location']
        return {
            'warehouses': [{'id': w.id, 'name': w.name} for w in warehouses],
            'warehouse_id': warehouse.id,
            'can_edit': self.env.user.has_group('stock.group_stock_manager'),
            'locations': [{'id': loc.id, 'name': loc.complete_name} for loc in locations],
            'map': stock_map._map_data() if stock_map else False,
        }

    @api.model
    def create_map(self, warehouse_id):
        """Create the map of a warehouse with a draft drawing: one rack per sub-location of its stock."""
        stock_map = self.create({'warehouse_id': warehouse_id})
        stock_map._draw_draft()
        return stock_map.id

    def save_map(self, floors):
        """Replace the drawing with the floors of the screen, in their order.

        :param floors: [{id or False, name, width, height, shapes: [{id or False, kind, ...}]}];
            a floor or a shape left out is deleted
        :raise UserError: without any floor
        """
        self.ensure_one()
        if not floors:
            raise UserError(_('A map keeps at least one floor.'))
        floor_commands = []
        kept_floors = set()
        for sequence, floor in enumerate(floors):
            record = self.floor_ids.filtered(lambda f: f.id == floor.get('id'))
            shape_commands = []
            kept_shapes = set()
            for shape in floor.get('shapes') or []:
                vals = {field: shape.get(field) or False for field in SHAPE_FIELDS}
                if shape.get('id') in record.shape_ids.ids:
                    kept_shapes.add(shape['id'])
                    shape_commands.append(fields.Command.update(shape['id'], vals))
                else:
                    shape_commands.append(fields.Command.create(vals))
            shape_commands += [fields.Command.delete(i) for i in set(record.shape_ids.ids) - kept_shapes]
            vals = {
                'name': floor.get('name') or _('Floor %s', sequence + 1),
                'sequence': sequence,
                'width': floor.get('width'),
                'height': floor.get('height'),
                'shape_ids': shape_commands,
            }
            if record:
                kept_floors.add(record.id)
                floor_commands.append(fields.Command.update(record.id, vals))
            else:
                floor_commands.append(fields.Command.create(vals))
        floor_commands += [fields.Command.delete(i) for i in set(self.floor_ids.ids) - kept_floors]
        self.write({'floor_ids': floor_commands})
        # The cache keeps the floors in their former order; the screen needs the new one
        self.invalidate_recordset(['floor_ids'])
        return self._map_data()

    def compute_heat(self, product_search=False, categ_id=False):
        """{shape id: {qty, products, levels}} for the stock under each rack, pallet and zone.

        The levels of a rack are its sub-locations, from the bottom in the order of their names
        (A-T1, A-T2...): [{location_id, name, qty, products}]. Odoo 19 has no location height any more.
        """
        self.ensure_one()
        shapes = self.shape_ids.filtered('location_id')
        result = {shape.id: {'qty': 0.0, 'products': 0, 'levels': []} for shape in shapes}
        if not shapes:
            return result
        # Totals by key, a shape id or ('level', location id); the stock of a location
        # counts for the keys of all its parents
        totals = defaultdict(lambda: {'qty': 0.0, 'products': 0})
        keys_by_location = defaultdict(list)
        for shape in shapes:
            keys_by_location[shape.location_id.id].append(shape.id)
            totals[shape.id] = result[shape.id]
        racks = shapes.filtered(lambda s: s.kind == 'rack')
        levels = self.env['stock.location'].search([
            ('location_id', 'in', racks.location_id.ids), ('usage', '=', 'internal'),
        ], order='name, id')
        for rack in racks:
            for level in levels.filtered(lambda l: l.location_id == rack.location_id):
                key = ('level', level.id)
                keys_by_location[level.id].append(key)
                result[rack.id]['levels'].append(dict(totals[key], location_id=level.id, name=level.name))

        groups = self.env['stock.quant']._read_group(
            self._quant_domain(shapes.location_id, product_search, categ_id),
            groupby=['location_id', 'product_id'],
            aggregates=['quantity:sum'],
        )
        products_by_key = defaultdict(set)
        for location, product, qty in groups:
            for ancestor_id in (int(part) for part in location.parent_path.split('/') if part):
                for key in keys_by_location.get(ancestor_id, ()):
                    totals[key]['qty'] += qty
                    if qty > 0:
                        products_by_key[key].add(product.id)
        for key, product_ids in products_by_key.items():
            totals[key]['products'] = len(product_ids)
        for heat in result.values():
            for level in heat['levels']:
                level.update(totals[('level', level['location_id'])])
        return result

    def action_quants(self, shape_id, product_search=False, categ_id=False, location_id=False):
        """The stock behind a shape, or one of its levels, with the filters of the screen."""
        self.ensure_one()
        shape = self.shape_ids.filtered(lambda s: s.id == shape_id)
        location = shape.location_id
        name = shape.label or location.complete_name
        if location_id:
            level = self.env['stock.location'].search([('id', '=', location_id), ('id', 'child_of', location.id)])
            if level:
                location, name = level, f'{name} / {level.name}'
        return {
            'type': 'ir.actions.act_window',
            'name': name,
            'res_model': 'stock.quant',
            'views': [(self.env.ref('stock.view_stock_quant_tree').id, 'list'), (False, 'pivot')],
            'domain': self._quant_domain(location, product_search, categ_id),
            'context': {'search_default_productgroup': 1},
        }

    # ----------------------------------------------------------
    # Helpers
    # ----------------------------------------------------------

    @api.model
    def _quant_domain(self, locations, product_search=False, categ_id=False):
        domain = [('location_id', 'child_of', locations.ids), ('location_id.usage', '=', 'internal')]
        if product_search:
            domain.append(('product_id', 'ilike', product_search))
        if categ_id:
            domain.append(('product_id.categ_id', 'child_of', categ_id))
        return domain

    def _map_data(self):
        self.ensure_one()
        return {
            'id': self.id,
            'floors': [{
                'id': floor.id,
                'name': floor.name,
                'width': floor.width,
                'height': floor.height,
                'shapes': [
                    dict({field: shape[field] for field in SHAPE_FIELDS}, id=shape.id,
                         location_id=shape.location_id.id)
                    for shape in floor.shape_ids
                ],
            } for floor in self.floor_ids],
        }

    def _draw_draft(self):
        """A first floor: racks of 4 x 2 cells, 6 per row, an aisle between rows, walls around and a door."""
        self.ensure_one()
        stock = self.warehouse_id.lot_stock_id
        children = self.env['stock.location'].search(
            [('location_id', '=', stock.id), ('usage', '=', 'internal')], order='complete_name')
        targets = children or stock
        per_row, rack_w, rack_h, gap = 6, 4, 2, 1
        shapes = []
        for index, location in enumerate(targets):
            row, col = divmod(index, per_row)
            shapes.append(fields.Command.create({
                'kind': 'rack',
                'label': location.name,
                'location_id': location.id,
                'x': 2 + col * (rack_w + gap),
                'y': 2 + row * (rack_h + 2),
                'width': rack_w,
                'height': rack_h,
            }))
        rows = (len(targets) + per_row - 1) // per_row
        width = max(4 + per_row * (rack_w + gap), 20)
        height = max(4 + rows * (rack_h + 2), 12)
        for kind, label, x, y, w, h in (
            ('wall', False, 0, 0, width, 1),
            ('wall', False, 0, height - 1, width, 1),
            ('wall', False, 0, 1, 1, height - 2),
            ('wall', False, width - 1, 1, 1, height - 2),
            ('door', _('Door'), 2, height - 1, 3, 1),
        ):
            shapes.append(fields.Command.create(
                {'kind': kind, 'label': label, 'x': x, 'y': y, 'width': w, 'height': h}))
        self.write({'floor_ids': [fields.Command.create(
            {'name': _('Floor 1'), 'width': width, 'height': height, 'shape_ids': shapes})]})


class StockMapFloor(models.Model):
    """One storey of a warehouse, drawn on its own grid."""

    _name = 'tricasia.stock.map.floor'
    _description = 'Warehouse Map Floor'
    _order = 'sequence, id'

    map_id = fields.Many2one('tricasia.stock.map', string='Map', required=True, ondelete='cascade', index=True)
    name = fields.Char(required=True)
    sequence = fields.Integer(default=10)
    width = fields.Integer(default=40, help='In grid cells, one cell being a metre in 3D.')
    height = fields.Integer(default=24, help='In grid cells, one cell being a metre in 3D.')
    shape_ids = fields.One2many('tricasia.stock.map.shape', 'floor_id', string='Shapes')

    _size_check = models.Constraint('CHECK(width > 0 AND height > 0)', 'A floor needs a size.')


class StockMapShape(models.Model):
    _name = 'tricasia.stock.map.shape'
    _description = 'Warehouse Map Shape'
    _order = 'id'

    floor_id = fields.Many2one(
        'tricasia.stock.map.floor', string='Floor', required=True, ondelete='cascade', index=True)
    map_id = fields.Many2one(related='floor_id.map_id', store=True, index=True)
    kind = fields.Selection(SHAPE_KINDS, required=True, default='rack')
    label = fields.Char()
    location_id = fields.Many2one(
        'stock.location', ondelete='set null',
        help='The stock of this location and its sub-locations colours the shape.')
    x = fields.Integer()
    y = fields.Integer()
    width = fields.Integer(default=1)
    height = fields.Integer(default=1)

    @api.constrains('kind', 'location_id', 'map_id')
    def _check_location(self):
        for shape in self.filtered('location_id'):
            warehouse = shape.map_id.warehouse_id
            if shape.kind not in STOCK_KINDS:
                raise ValidationError(_('Only racks, pallets and zones can be linked to a location.'))
            if shape.location_id.warehouse_id != warehouse:
                raise ValidationError(_('The location %(location)s is not in the warehouse %(warehouse)s.',
                                        location=shape.location_id.complete_name, warehouse=warehouse.name))

    @api.constrains('width', 'height')
    def _check_size(self):
        if any(shape.width < 1 or shape.height < 1 for shape in self):
            raise ValidationError(_('A shape is at least one cell wide and high.'))
