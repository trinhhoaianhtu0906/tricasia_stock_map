"""Give every existing map a first floor holding its size and all its shapes.

Runs before the models are updated: the shapes must point to a floor by the time
``floor_id`` becomes required and ``map_id`` becomes a field related to it.
"""


def migrate(cr, version):
    cr.execute("""
        CREATE TABLE IF NOT EXISTS tricasia_stock_map_floor (
            id SERIAL PRIMARY KEY,
            map_id INTEGER,
            name VARCHAR,
            sequence INTEGER,
            width INTEGER,
            height INTEGER,
            create_uid INTEGER,
            create_date TIMESTAMP,
            write_uid INTEGER,
            write_date TIMESTAMP
        )
    """)
    cr.execute("""
        INSERT INTO tricasia_stock_map_floor
               (map_id, name, sequence, width, height, create_uid, create_date, write_uid, write_date)
        SELECT m.id, 'Floor 1', 0, m.width, m.height,
               m.create_uid, m.create_date, m.write_uid, NOW() AT TIME ZONE 'UTC'
          FROM tricasia_stock_map m
         WHERE NOT EXISTS (SELECT 1 FROM tricasia_stock_map_floor f WHERE f.map_id = m.id)
    """)
    cr.execute("ALTER TABLE tricasia_stock_map_shape ADD COLUMN IF NOT EXISTS floor_id INTEGER")
    cr.execute("""
        UPDATE tricasia_stock_map_shape s
           SET floor_id = f.id
          FROM tricasia_stock_map_floor f
         WHERE f.map_id = s.map_id AND s.floor_id IS NULL
    """)
    # The size moved to the floors
    cr.execute("ALTER TABLE tricasia_stock_map DROP CONSTRAINT IF EXISTS tricasia_stock_map_size_check")
