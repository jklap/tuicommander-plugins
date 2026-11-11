"""Generate real Parquet fixtures with PyArrow (not a hand-written Parquet mock)."""
from pathlib import Path
from datetime import date, datetime, timezone
from decimal import Decimal
import json
import pyarrow as pa
import pyarrow.parquet as pq

root = Path(__file__).resolve().parents[1] / 'fixtures'
root.mkdir(exist_ok=True)
schema = pa.schema([
    pa.field('seq', pa.int32(), nullable=False),
    pa.field('integer', pa.int64()), pa.field('float', pa.float64()),
    pa.field('text', pa.string()), pa.field('boolean', pa.bool_()),
    pa.field('timestamp', pa.timestamp('ms', tz='UTC')), pa.field('date', pa.date32()),
    pa.field('decimal', pa.decimal128(30, 2)), pa.field('list', pa.list_(pa.int32())),
    pa.field('struct', pa.struct([('x', pa.string())])),
])
rows = []
for i in range(205):
    rows.append(dict(seq=i, integer=9007199254740993, float=1.25, text='<script>&text',
                     boolean=True, timestamp=datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
                     date=date(2024, 1, 2), decimal=Decimal('12345678901234567890.34'), list=[1, 2], struct={'x': 'nested'}))
rows[1] = {key: (1 if key == 'seq' else None) for key in rows[1]}
table = pa.Table.from_pylist(rows, schema=schema)
for codec in ['snappy', 'gzip', 'zstd']:
    path = root / f'{codec}.parquet'
    pq.write_table(table, path, compression=codec, row_group_size=60)
    meta = pq.read_metadata(path)
    offsets = [min(meta.row_group(i).column(j).data_page_offset for j in range(meta.num_columns)) for i in range(meta.num_row_groups)]
    (root / f'{codec}.json').write_text(json.dumps(dict(producer=f'pyarrow {pa.__version__}', rows=205, row_group_starts=[0,60,120,180], data_offsets=offsets)))
