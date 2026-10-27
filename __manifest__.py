{
    'name': 'Tricasia Warehouse Map',
    'summary': 'Draw the floor plan of a warehouse and see its stock as a 3D heatmap',
    'description': """
        Draw a warehouse on a grid - racks, pallets, zones, aisles, walls,
        doors - by drag and drop, link racks, pallets and zones to stock
        locations, and see the stock quantity as a heatmap in 2D or 3D.
        In 3D, orbit around the warehouse or walk through it.
        Ported from beesuite_stock_map (Odoo 16).
    """,
    'version': '19.0.1.1.0',
    'category': 'Inventory/Inventory',
    'license': 'LGPL-3',
    'author': 'Tricasia',
    'depends': [
        'stock',
    ],
    'data': [
        'security/ir.model.access.csv',
        'security/security.xml',
        'views/stock_map_views.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'tricasia_stock_map/static/src/scss/stock_map.scss',
            'tricasia_stock_map/static/src/js/scene3d.js',
            'tricasia_stock_map/static/src/js/stock_map.js',
            'tricasia_stock_map/static/src/xml/stock_map.xml',
        ],
    },
    'installable': True,
    'application': False,
}
