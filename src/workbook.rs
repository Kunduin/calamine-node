use std::sync::{Arc, Mutex};

use napi::{Env, Task, bindgen_prelude::*};
use napi_derive::napi;

use crate::{
    sheet::LoadTask,
    source::Book,
    state::{Shared, error, lock},
    vba::VbaTask,
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

enum Input {
    Path(String),
    Bytes(Vec<u8>),
}

pub struct OpenTask {
    input: Option<Input>,
    max_bytes: u32,
}

#[napi]
impl Task for OpenTask {
    type Output = NativeWorkbook;
    type JsValue = NativeWorkbook;

    fn compute(&mut self) -> Result<Self::Output> {
        let input = self
            .input
            .take()
            .ok_or_else(|| error("ERR_STATE", "task already consumed"))?;
        let book = match input {
            Input::Path(path) => Book::open_file(path, self.max_bytes)?,
            Input::Bytes(bytes) => Book::open_bytes(bytes, self.max_bytes)?,
        };
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

        Ok(NativeWorkbook {
            state: Arc::new(Mutex::new(Some(book))),
            info: WorkbookInfo {
                format,
                sheets,
                defined_names,
            },
        })
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn open_path(path: String, max_bytes: u32) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask {
        input: Some(Input::Path(path)),
        max_bytes,
    })
}

#[napi]
pub fn open_bytes(bytes: Buffer, max_bytes: u32) -> AsyncTask<OpenTask> {
    // Snapshot before scheduling. No task may borrow JavaScript memory.
    AsyncTask::new(OpenTask {
        input: Some(Input::Bytes(bytes.to_vec())),
        max_bytes,
    })
}

#[napi]
pub struct NativeWorkbook {
    state: Shared<Book>,
    info: WorkbookInfo,
}

pub struct CloseBookTask(Shared<Book>);

#[napi]
impl Task for CloseBookTask {
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
impl NativeWorkbook {
    #[napi(getter)]
    pub fn info(&self) -> WorkbookInfo {
        self.info.clone()
    }

    #[napi]
    pub fn load_sheet(&self, index: u32, max_cells: u32, formulas: bool) -> AsyncTask<LoadTask> {
        AsyncTask::new(LoadTask::new(
            self.state.clone(),
            index,
            max_cells,
            formulas,
        ))
    }

    #[napi]
    pub fn vba_project(&self, max_bytes: u32) -> AsyncTask<VbaTask> {
        AsyncTask::new(VbaTask::new(self.state.clone(), max_bytes))
    }

    #[napi]
    pub fn close(&self) -> AsyncTask<CloseBookTask> {
        AsyncTask::new(CloseBookTask(self.state.clone()))
    }
}
