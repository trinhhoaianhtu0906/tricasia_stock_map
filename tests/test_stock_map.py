from odoo import Command
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests import TransactionCase, tagged


@tagged('post_install', '-at_install')
class TestStockMap(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.warehouse = cls.env['stock.warehouse'].create({'name': 'Map WH', 'code': 'MAPWH'})
        cls.stock = cls.warehouse.lot_stock_id
        Location = cls.env['stock.location']
        cls.rack_a = Location.create({'name': 'A', 'location_id': cls.stock.id})
        cls.rack_b = Location.create({'name': 'B', 'location_id': cls.stock.id})
        cls.shelf_a1 = Location.create({'name': 'A1', 'location_id': cls.rack_a.id})
        cls.category = cls.env['product.category'].create({'name': 'Map category'})
        cls.bolt = cls.env['product.product'].create(
            {'name': 'Map bolt', 'default_code': 'MBOLT', 'is_storable': True})
        cls.nut = cls.env['product.product'].create(
            {'name': 'Map nut', 'is_storable': True, 'categ_id': cls.category.id})
        Quant = cls.env['stock.quant']
        Quant._update_available_quantity(cls.bolt, cls.shelf_a1, 10)
        Quant._update_available_quantity(cls.nut, cls.rack_a, 4)
        Quant._update_available_quantity(cls.nut, cls.rack_b, 3)
        cls.Map = cls.env['tricasia.stock.map']

    def _map(self):
        return self.Map.browse(self.Map.create_map(self.warehouse.id))

    def _shape(self, stock_map, location):
        return stock_map.shape_ids.filtered(lambda s: s.location_id == location)

    def _with(self, stock_map, *shapes):
        """Save the map with extra shapes on its first floor, keeping what it has."""
        floors = stock_map._map_data()['floors']
        floors[0]['shapes'] += list(shapes)
        stock_map.save_map(floors)

    @staticmethod
    def _floor(shapes, width=20, height=20, **values):
        return dict({'id': False, 'name': 'Ground', 'width': width, 'height': height, 'shapes': shapes}, **values)

    def test_draft_draws_racks_walls_and_a_door_on_a_first_floor(self):
        stock_map = self._map()
        self.assertEqual(len(stock_map.floor_ids), 1)
        floor = stock_map.floor_ids
        self.assertEqual(floor.shape_ids, stock_map.shape_ids)
        kinds = stock_map.shape_ids.mapped('kind')
        racks = stock_map.shape_ids.filtered(lambda s: s.kind == 'rack')
        self.assertEqual(racks.location_id, self.rack_a | self.rack_b)
        self.assertEqual(kinds.count('door'), 1)
        self.assertEqual(kinds.count('wall'), 4)
        for shape in stock_map.shape_ids:
            self.assertLessEqual(shape.x + shape.width, floor.width)
            self.assertLessEqual(shape.y + shape.height, floor.height)

    def test_heat_adds_the_stock_of_sub_locations(self):
        stock_map = self._map()
        heat = stock_map.compute_heat()
        rack_a = heat[self._shape(stock_map, self.rack_a).id]
        self.assertEqual(rack_a['qty'], 14)
        self.assertEqual(rack_a['products'], 2)
        self.assertNotIn('value', rack_a)
        self.assertEqual(heat[self._shape(stock_map, self.rack_b).id]['qty'], 3)

    def test_heat_zone_and_rack_overlap(self):
        stock_map = self._map()
        self._with(stock_map, {'kind': 'zone', 'location_id': self.stock.id, 'x': 0, 'y': 0, 'width': 5, 'height': 5})
        heat = stock_map.compute_heat()
        self.assertEqual(heat[self._shape(stock_map, self.stock).id]['qty'], 17)
        self.assertEqual(heat[self._shape(stock_map, self.rack_a).id]['qty'], 14)

    def test_pallet_holds_the_stock_of_its_location(self):
        floor = self.env['stock.location'].create({'name': 'P-01', 'location_id': self.stock.id})
        self.env['stock.quant']._update_available_quantity(self.bolt, floor, 25)
        stock_map = self._map()
        self._with(stock_map, {'kind': 'pallet', 'label': 'P-01', 'location_id': floor.id,
                               'x': 1, 'y': 1, 'width': 1, 'height': 1})
        pallet = stock_map.shape_ids.filtered(lambda s: s.kind == 'pallet')
        self.assertEqual(len(pallet), 1)
        heat = stock_map.compute_heat()[pallet.id]
        self.assertEqual((heat['qty'], heat['products'], heat['levels']), (25, 1, []))
        action = stock_map.action_quants(pallet.id)
        self.assertEqual(self.env['stock.quant'].search(action['domain']).location_id, floor)
        self.assertEqual(action['name'], 'P-01')

    def test_heat_filters(self):
        stock_map = self._map()
        shape_a = self._shape(stock_map, self.rack_a)
        self.assertEqual(stock_map.compute_heat(product_search='MBOLT')[shape_a.id]['qty'], 10)
        self.assertEqual(stock_map.compute_heat(categ_id=self.category.id)[shape_a.id]['qty'], 4)
        action = stock_map.action_quants(shape_a.id, categ_id=self.category.id)
        quants = self.env['stock.quant'].search(action['domain'])
        self.assertEqual(quants.product_id, self.nut)
        self.assertEqual(quants.location_id, self.rack_a)

    def test_save_keeps_updates_creates_and_removes(self):
        stock_map = self._map()
        floor = stock_map._map_data()['floors'][0]
        kept, removed = floor['shapes'][0], floor['shapes'][1]
        kept['x'] = 7
        new = {'kind': 'wall', 'label': 'North', 'x': 0, 'y': 0, 'width': 10, 'height': 1}
        result = stock_map.save_map([dict(floor, width=30, height=15, shapes=[kept, new])])
        self.assertEqual([(f['id'], f['width'], f['height']) for f in result['floors']], [(floor['id'], 30, 15)])
        self.assertEqual(len(stock_map.shape_ids), 2)
        self.assertEqual(stock_map.shape_ids.browse(kept['id']).x, 7)
        self.assertNotIn(removed['id'], stock_map.shape_ids.ids)
        self.assertIn('North', stock_map.shape_ids.mapped('label'))

    def test_floors_are_saved_in_order_with_their_own_shapes(self):
        mezzanine = self.env['stock.location'].create({'name': 'M-01', 'location_id': self.stock.id})
        self.env['stock.quant']._update_available_quantity(self.nut, mezzanine, 5)
        stock_map = self._map()
        ground = stock_map._map_data()['floors'][0]
        pallet = {'kind': 'pallet', 'label': 'M-01', 'location_id': mezzanine.id, 'x': 2, 'y': 2, 'width': 1, 'height': 1}
        result = stock_map.save_map([
            ground,
            self._floor([pallet], width=12, height=8, name='Mezzanine'),
        ])
        self.assertEqual([f['name'] for f in result['floors']], [ground['name'], 'Mezzanine'])
        first, second = stock_map.floor_ids
        self.assertEqual((second.name, second.width, second.height), ('Mezzanine', 12, 8))
        self.assertEqual(second.shape_ids.mapped('kind'), ['pallet'])
        self.assertEqual(second.shape_ids.map_id, stock_map)
        self.assertEqual(stock_map.compute_heat()[second.shape_ids.id]['qty'], 5)

        # Reorder: the mezzanine goes first, keeping its id and its shapes
        result = stock_map.save_map(list(reversed(result['floors'])))
        self.assertEqual(stock_map.floor_ids.ids, [second.id, first.id])

        # A floor left out goes with its shapes
        stock_map.save_map([f for f in result['floors'] if f['id'] == first.id])
        self.assertEqual(stock_map.floor_ids, first)
        self.assertFalse(stock_map.shape_ids.filtered(lambda s: s.kind == 'pallet'))
        self.assertFalse(self.env['tricasia.stock.map.shape'].search([('floor_id', '=', second.id)]))

    def test_a_map_keeps_a_floor(self):
        stock_map = self._map()
        with self.assertRaises(UserError):
            stock_map.save_map([])
        with self.assertRaises(Exception), self.cr.savepoint():
            stock_map.save_map([self._floor([], width=0)])

    def test_shape_location_must_belong_to_the_warehouse(self):
        stock_map = self._map()
        other = self.env['stock.warehouse'].create({'name': 'Other WH', 'code': 'OTHWH'})
        shape = {'kind': 'rack', 'location_id': other.lot_stock_id.id, 'x': 0, 'y': 0, 'width': 2, 'height': 2}
        with self.assertRaises(ValidationError):
            stock_map.save_map([self._floor([shape])])
        with self.assertRaises(ValidationError):
            stock_map.save_map([self._floor([dict(shape, kind='wall', location_id=self.rack_a.id)])])
        with self.assertRaises(ValidationError):
            stock_map.save_map([self._floor([dict(shape, location_id=False, width=0)])])

    def test_one_map_per_warehouse(self):
        self._map()
        with self.assertRaises(Exception), self.cr.savepoint():
            self.Map.create({'warehouse_id': self.warehouse.id})

    def test_load_and_rights(self):
        stock_map = self._map()
        user = self.env['res.users'].create({
            'name': 'Map user', 'login': 'map_user',
            'group_ids': [Command.set([self.env.ref('stock.group_stock_user').id])],
        })
        data = self.Map.with_user(user).load_map(self.warehouse.id)
        self.assertFalse(data['can_edit'])
        self.assertEqual(data['map']['id'], stock_map.id)
        self.assertIn(self.shelf_a1.id, [loc['id'] for loc in data['locations']])
        self.assertTrue(stock_map.with_user(user).compute_heat())
        with self.assertRaises(AccessError):
            stock_map.with_user(user).save_map(stock_map._map_data()['floors'])

    def test_heat_levels_of_a_rack(self):
        Location = self.env['stock.location']
        # Created top first: the levels follow their names, not their creation
        top = Location.create({'name': 'B-T2', 'location_id': self.rack_b.id})
        bottom = Location.create({'name': 'B-T1', 'location_id': self.rack_b.id})
        self.env['stock.quant']._update_available_quantity(self.bolt, top, 6)
        stock_map = self._map()
        shape_b = self._shape(stock_map, self.rack_b)
        heat = stock_map.compute_heat()[shape_b.id]
        self.assertEqual(heat['qty'], 9)
        self.assertEqual([(level['location_id'], level['qty']) for level in heat['levels']],
                         [(bottom.id, 0), (top.id, 6)])
        self.assertEqual(stock_map.compute_heat()[self._shape(stock_map, self.rack_a).id]['levels'],
                         [{'location_id': self.shelf_a1.id, 'name': 'A1', 'qty': 10.0, 'products': 1}])

        action = stock_map.action_quants(shape_b.id, location_id=top.id)
        self.assertEqual(self.env['stock.quant'].search(action['domain']).location_id, top)
        # A location outside the rack falls back to the rack
        action = stock_map.action_quants(shape_b.id, location_id=self.shelf_a1.id)
        self.assertEqual(self.env['stock.quant'].search(action['domain']).location_id, self.rack_b | top)
