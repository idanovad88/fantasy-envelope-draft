#!/usr/bin/env python3
"""Writes the styled, right-to-left workbook for export-draft-results.mjs.

    python scripts/xlsx_styled.py <payload.json> <out.xlsx>

The payload is {"headers": [...], "widths": [...], "sheets": [{"name", "rows"}]}.

This exists because the community build of SheetJS writes no cell styles and no
`rightToLeft` sheet view, so a Hebrew workbook comes out left-to-right and
unformatted. The Node script falls back to a plain SheetJS workbook if this
script is unavailable, so nothing here is load-bearing for the data itself.
"""
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

FORBIDDEN = set('[]:*?/\\')
HEADER_FILL = PatternFill('solid', fgColor='1F3864')
HEADER_FONT = Font(bold=True, color='FFFFFF')
CENTER = Alignment(horizontal='center', vertical='center')


def sheet_name(name, used):
    clean = ''.join(' ' if ch in FORBIDDEN else ch for ch in name)[:31] or 'sheet'
    candidate, n = clean, 2
    while candidate in used:                      # Excel refuses duplicate names
        suffix = f' ({n})'
        candidate, n = clean[: 31 - len(suffix)] + suffix, n + 1
    used.add(candidate)
    return candidate


def main():
    payload = json.load(open(sys.argv[1], encoding='utf-8'))
    headers, widths = payload['headers'], payload['widths']

    wb = Workbook()
    wb.remove(wb.active)
    used = set()

    for sheet in payload['sheets']:
        ws = wb.create_sheet(sheet_name(sheet['name'], used))
        ws.append(headers)
        for row in sheet['rows']:
            ws.append(row)

        ws.sheet_view.rightToLeft = True
        ws.freeze_panes = 'A2'
        ws.auto_filter.ref = f'A1:{get_column_letter(len(headers))}{ws.max_row}'
        ws.row_dimensions[1].height = 22
        for i, width in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = width
        for cell in ws[1]:
            cell.fill, cell.font, cell.alignment = HEADER_FILL, HEADER_FONT, CENTER
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                if isinstance(cell.value, (int, float)):
                    cell.number_format = '0'
                    cell.alignment = CENTER

    wb.save(sys.argv[2])


if __name__ == '__main__':
    main()
