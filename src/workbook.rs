use std::sync::{Arc, Mutex};

use napi::{Env, Result, bindgen_prelude::AsyncBlock};
use napi_derive::napi;

use crate::{
    cancellation::NativeCancellation,
    executor::Executor,
    sheet::{NativeSheet, SheetData},
    source::Book,
    state::{Shared, error, lock},
    vba::{VbaProject, read_vba},
};

#[napi(object)]
#[derive(Clone)]
pub struct SheetInfo {
    pub name: String,
    pub index: u32,
    pub kind: String,
    pub visibility: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct DefinedName {
    pub name: String,
    pub formula: String,
}

#[napi(object)]
#[derive(Clone)]
pub struct WorkbookInfo {
    pub format: String,
    pub sheets: Vec<SheetInfo>,
    pub defined_names: Vec<DefinedName>,
}

struct WorkbookState {
    book: Book,
    sheet: Option<Shared<SheetData>>,
}

#[napi]
pub struct NativeWorkbook {
    state: Shared<WorkbookState>,
    executor: Arc<Executor>,
    info: WorkbookInfo,
}

impl NativeWorkbook {
    pub(crate) fn new(book: Book, executor: Arc<Executor>) -> Self {
        let format = book.format().to_owned();

        let sheets = book
            .sheets_metadata()
            .iter()
            .enumerate()
            .map(|(index, sheet)| SheetInfo {
                name: sheet.name.clone(),
                index: index as u32,
                kind: match sheet.typ {
                    calamine::SheetType::WorkSheet => "worksheet",
                    calamine::SheetType::DialogSheet => "dialog",
                    calamine::SheetType::MacroSheet => "macro",
                    calamine::SheetType::ChartSheet => "chart",
                    calamine::SheetType::Vba => "vba",
                }
                .into(),
                visibility: match sheet.visible {
                    calamine::SheetVisible::Visible => "visible",
                    calamine::SheetVisible::Hidden => "hidden",
                    calamine::SheetVisible::VeryHidden => "very-hidden",
                }
                .into(),
            })
            .collect();
        let defined_names = book
            .defined_names()
            .iter()
            .map(|(name, formula)| DefinedName {
                name: name.clone(),
                formula: formula.clone(),
            })
            .collect();

        Self {
            state: Arc::new(Mutex::new(Some(WorkbookState { book, sheet: None }))),
            executor,
            info: WorkbookInfo {
                format,
                sheets,
                defined_names,
            },
        }
    }
}

#[napi]
impl NativeWorkbook {
    #[napi(getter)]
    pub fn info(&self) -> WorkbookInfo {
        self.info.clone()
    }

    #[napi]
    pub fn load_sheet(
        &self,
        env: Env,
        index: u32,
        max_cells: Option<u32>,
        formulas: bool,
        signal: Option<&NativeCancellation>,
    ) -> Result<AsyncBlock<NativeSheet>> {
        let state = self.state.clone();
        let executor = self.executor.clone();

        self.executor.submit(&env, signal, move || {
            let mut guard = lock(&state)?;
            let workbook = guard
                .as_mut()
                .ok_or_else(|| error("ERR_CLOSED", "workbook is closed"))?;
            if let Some(sheet) = &workbook.sheet
                && lock(sheet)?.is_some()
            {
                return Err(error(
                    "ERR_BUSY",
                    "close the active sheet before reading another",
                ));
            }

            let sheet =
                NativeSheet::load(&mut workbook.book, index, max_cells, formulas, executor)?;
            // Retain the range so workbook.close() also disposes a paused iterator.
            workbook.sheet = Some(sheet.shared_state());
            Ok(sheet)
        })
    }

    #[napi]
    pub fn vba_project(
        &self,
        env: Env,
        max_bytes: u32,
        signal: Option<&NativeCancellation>,
    ) -> Result<AsyncBlock<Option<VbaProject>>> {
        let state = self.state.clone();
        self.executor.submit(&env, signal, move || {
            let mut guard = lock(&state)?;
            let workbook = guard
                .as_mut()
                .ok_or_else(|| error("ERR_CLOSED", "workbook is closed"))?;
            read_vba(&mut workbook.book, max_bytes)
        })
    }

    #[napi]
    pub fn close(&self, env: Env) -> Result<AsyncBlock<()>> {
        let state = self.state.clone();
        self.executor.cleanup(&env, move || {
            if let Some(workbook) = lock(&state)?.take()
                && let Some(sheet) = workbook.sheet
            {
                lock(&sheet)?.take();
            }
            Ok(())
        })
    }
}
