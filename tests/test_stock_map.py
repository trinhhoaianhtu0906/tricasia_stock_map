from odoo import Command
from odoo.exceptions import AccessError, ValidationError
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
        """Save the map with extra shapes, keeping what it has."""
        stock_map.save_map(stock_map._map_data()['shapes'] + list(shapes), stock_map.width, stock_map.height)

    def test_draft_draws_racks_walls_and_a_door(self):
        stock_map = self._map()
        kinds = stock_map.shape_ids.mapped('kind')
        racks = stock_map.shape_ids.filtered(lambda s: s.kind == 'rack')
        self.assertEqual(racks.location_id, self.rack_a | self.rack_b)
        self.assertEqual(kinds.count('door'), 1)
        self.assertEqual(kinds.count('wall'), 4)
        for shape in stock_map.shape_ids:
            self.assertLessEqual(shape.x + shape.width, stock_map.width)
            self.assertLessEqual(shape.y + shape.height, stock_map.height)

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
        data = stock_map._map_data()
        kept, removed = data['shapes'][0], data['shapes'][1]
        kept['x'] = 7
        new = {'kind': 'wall', 'label': 'North', 'x': 0, 'y': 0, 'width': 10, 'height': 1}
        result = stock_map.save_map([kept, new], 30, 15)
        self.assertEqual((result['width'], result['height']), (30, 15))
        self.assertEqual(len(stock_map.shape_ids), 2)
        self.assertEqual(stock_map.shape_ids.browse(kept['id']).x, 7)
        self.assertNotIn(removed['id'], stock_map.shape_ids.ids)
        self.assertIn('North', stock_map.shape_ids.mapped('label'))

    def test_shape_location_must_belong_to_the_warehouse(self):
        stock_map = self._map()
        other = self.env['stock.warehouse'].create({'name': 'Other WH', 'code': 'OTHWH'})
        shape = {'kind': 'rack', 'location_id': other.lot_stock_id.id, 'x': 0, 'y': 0, 'width': 2, 'height': 2}
        with self.assertRaises(ValidationError):
            stock_map.save_map([shape], 20, 20)
        with self.assertRaises(ValidationError):
            stock_map.save_map([dict(shape, kind='wall', location_id=self.rack_a.id)], 20, 20)
        with self.assertRaises(ValidationError):
            stock_map.save_map([dict(shape, location_id=False, width=0)], 20, 20)

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
            stock_map.with_user(user).save_map([], 20, 20)

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
