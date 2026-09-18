use std::sync::{Arc, Mutex};

use calamine::{Data, Range};
use napi::{Env, Task, bindgen_prelude::*};
use napi_derive::napi;

use crate::{
    cell::{CellValue, cell},
    source::Book,
    state::{Shared, error, lock},
};

enum SheetData {
    Values(Range<Data>),
    Formulas(Range<String>),
}

impl SheetData {
    fn size(&self) -> (usize, usize) {
        match self {
            Self::Values(r) => r.get_size(),
            Self::Formulas(r) => r.get_size(),
        }
    }

    fn start(&self) -> Option<(u32, u32)> {
        match self {
            Self::Values(r) => r.start(),
            Self::Formulas(r) => r.start(),
        }
    }

    fn cell(&self, row: usize, col: usize) -> CellValue {
        match self {
            Self::Values(range) => range.get((row, col)).map_or(Either5::D(Null), cell),
            Self::Formulas(range) => match range.get((row, col)) {
                Some(value) if !value.is_empty() => Either5::A(value.clone()),
                _ => Either5::D(Null),
            },
        }
    }
}

#[napi(object)]
#[derive(Clone)]
pub struct RangeInfo {
    pub row: Option<u32>,
    pub column: Option<u32>,
    pub row_count: u32,
    pub column_count: u32,
}

#[napi]
pub struct NativeSheet {
    state: Shared<SheetData>,
    info: RangeInfo,
}

pub struct LoadTask {
    state: Shared<Book>,
    index: u32,
    max_cells: u32,
    formulas: bool,
}

impl LoadTask {
    pub(crate) fn new(state: Shared<Book>, index: u32, max_cells: u32, formulas: bool) -> Self {
        Self {
            state,
            index,
            max_cells,
            formulas,
        }
    }
}

#[napi]
impl Task for LoadTask {
    type Output = NativeSheet;
    type JsValue = NativeSheet;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut guard = lock(&self.state)?;
        let book = guard
            .as_mut()
            .ok_or_else(|| error("ERR_CLOSED", "workbook is closed"))?;
        let name = book
            .sheets_metadata()
            .get(self.index as usize)
            .map(|sheet| sheet.name.clone())
            .ok_or_else(|| error("ERR_SHEET", "sheet index is out of bounds"))?;
        let data = if self.formulas {
            SheetData::Formulas(
                book.worksheet_formula(&name)
                    .map_err(|e| error("ERR_SHEET", e))?,
            )
        } else {
            SheetData::Values(
                book.worksheet_range(&name)
                    .map_err(|e| error("ERR_SHEET", e))?,
            )
        };
        let (rows, columns) = data.size();
        // Calamine has already allocated this range: a result limit, not a memory sandbox.
        if (rows as u64) * (columns as u64) > self.max_cells.into() {
            return Err(error(
                "ERR_CELL_LIMIT",
                "worksheet rectangle exceeds maxCells",
            ));
        }
        let origin = data.start();
        let info = RangeInfo {
            row: origin.map(|p| p.0),
            column: origin.map(|p| p.1),
            row_count: rows as u32,
            column_count: columns as u32,
        };
        Ok(NativeSheet {
            state: Arc::new(Mutex::new(Some(data))),
            info,
        })
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(object)]
pub struct Batch {
    pub rows: Vec<Vec<CellValue>>,
}

pub struct BatchTask {
    state: Shared<SheetData>,
    start: u32,
    count: u32,
}

#[napi]
impl Task for BatchTask {
    type Output = Batch;
    type JsValue = Batch;

    fn compute(&mut self) -> Result<Self::Output> {
        let guard = lock(&self.state)?;
        let data = guard
            .as_ref()
            .ok_or_else(|| error("ERR_CLOSED", "sheet is closed"))?;
        let (height, width) = data.size();
        let start = (self.start as usize).min(height);
        let end = start.saturating_add(self.count as usize).min(height);
        Ok(Batch {
            rows: (start..end)
                .map(|row| (0..width).map(|col| data.cell(row, col)).collect())
                .collect(),
        })
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CloseSheetTask(Shared<SheetData>);

#[napi]
impl Task for CloseSheetTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        lock(&self.0)?.take();
        Ok(())
    }

    fn resolve(&mut self, _: Env, _: ()) -> Result<()> {
        Ok(())
    }
}

#[napi]
impl NativeSheet {
    #[napi(getter)]
    pub fn info(&self) -> RangeInfo {
        self.info.clone()
    }

    #[napi]
    pub fn batch(&self, start: u32, count: u32) -> AsyncTask<BatchTask> {
        AsyncTask::new(BatchTask {
            state: self.state.clone(),
            start,
            count,
        })
    }

    #[napi]
    pub fn close(&self) -> AsyncTask<CloseSheetTask> {
        AsyncTask::new(CloseSheetTask(self.state.clone()))
    }
}
