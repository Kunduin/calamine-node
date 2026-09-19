use std::sync::{Arc, Mutex};

use calamine::{Data, Range};
use napi::{
    Env, Result,
    bindgen_prelude::{AsyncBlock, Either5, Null},
};
use napi_derive::napi;

use crate::{
    cancellation::NativeCancellation,
    cell::{CellValue, cell},
    executor::Executor,
    merged_cells::{CellRange, read_merged_cells},
    source::Book,
    state::{Shared, error, lock},
};

pub(crate) enum SheetData {
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
    pub merged_cells: Option<Vec<CellRange>>,
}

#[napi]
pub struct NativeSheet {
    state: Shared<SheetData>,
    executor: Arc<Executor>,
    info: RangeInfo,
}

impl NativeSheet {
    pub(crate) fn load(
        book: &mut Book,
        index: u32,
        max_cells: Option<u32>,
        formulas: bool,
        include_merged_cells: bool,
        executor: Arc<Executor>,
    ) -> Result<Self> {
        let name = book
            .sheets_metadata()
            .get(index as usize)
            .map(|sheet| sheet.name.clone())
            .ok_or_else(|| error("ERR_SHEET", "sheet index is out of bounds"))?;
        let data = if formulas {
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
        if let Some(limit) = max_cells
            && (rows as u64) * (columns as u64) > u64::from(limit)
        {
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
            merged_cells: if include_merged_cells {
                Some(read_merged_cells(book, &name)?)
            } else {
                None
            },
        };
        Ok(NativeSheet {
            state: Arc::new(Mutex::new(Some(data))),
            executor,
            info,
        })
    }

    pub(crate) fn shared_state(&self) -> Shared<SheetData> {
        self.state.clone()
    }
}

#[napi(object)]
pub struct Batch {
    pub rows: Vec<Vec<CellValue>>,
}

#[napi]
impl NativeSheet {
    #[napi(getter)]
    pub fn info(&self) -> RangeInfo {
        self.info.clone()
    }

    #[napi]
    pub fn batch(
        &self,
        env: Env,
        start: u32,
        count: u32,
        signal: Option<&NativeCancellation>,
    ) -> Result<AsyncBlock<Batch>> {
        let state = self.state.clone();
        self.executor.submit(&env, signal, move || {
            let guard = lock(&state)?;
            let data = guard
                .as_ref()
                .ok_or_else(|| error("ERR_CLOSED", "sheet is closed"))?;
            let (height, width) = data.size();
            let start = (start as usize).min(height);
            let end = start.saturating_add(count as usize).min(height);

            Ok(Batch {
                rows: (start..end)
                    .map(|row| (0..width).map(|col| data.cell(row, col)).collect())
                    .collect(),
            })
        })
    }

    #[napi]
    pub fn close(&self, env: Env) -> Result<AsyncBlock<()>> {
        let state = self.state.clone();
        self.executor.cleanup(&env, move || {
            lock(&state)?.take();
            Ok(())
        })
    }
}
