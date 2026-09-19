use std::io::{Read, Seek};

use calamine::{Dimensions, Sheets};
use napi::Result;
use napi_derive::napi;

use crate::{source::Book, state::error};

#[napi(object)]
#[derive(Clone)]
pub struct CellPosition {
    pub row: u32,
    pub column: u32,
}

#[napi(object)]
#[derive(Clone)]
pub struct CellRange {
    pub start: CellPosition,
    pub end: CellPosition,
}

pub(crate) fn read_merged_cells(book: &mut Book, name: &str) -> Result<Vec<CellRange>> {
    let dimensions = match book {
        Book::File(book) => merged_cells(book, name)?,
        Book::Bytes(book) => merged_cells(book, name)?,
    };

    Ok(dimensions
        .into_iter()
        .map(|range| CellRange {
            start: CellPosition {
                row: range.start.0,
                column: range.start.1,
            },
            end: CellPosition {
                row: range.end.0,
                column: range.end.1,
            },
        })
        .collect())
}

fn merged_cells<RS: Read + Seek>(book: &mut Sheets<RS>, name: &str) -> Result<Vec<Dimensions>> {
    match book {
        Sheets::Xls(book) => book
            .merge_cells_by_sheet_name(name)
            .map_err(|e| error("ERR_SHEET", e)),
        Sheets::Xlsx(book) => book
            .merge_cells_by_sheet_name(name)
            .map_err(|e| error("ERR_SHEET", e)),
        Sheets::Xlsb(_) | Sheets::Ods(_) => Err(error(
            "ERR_UNSUPPORTED",
            "merged cells are supported for XLS and XLSX workbooks only",
        )),
    }
}
