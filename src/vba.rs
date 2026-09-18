use napi::{Env, Task, bindgen_prelude::*};
use napi_derive::napi;

use crate::{
    source::Book,
    state::{Shared, error, lock},
};

#[napi(object)]
pub struct VbaModule {
    pub name: String,
    pub source: String,
}

#[napi(object)]
pub struct VbaReference {
    pub name: String,
    pub description: String,
    pub path: String,
}

#[napi(object)]
pub struct VbaProject {
    pub modules: Vec<VbaModule>,
    pub references: Vec<VbaReference>,
}

pub struct VbaTask {
    state: Shared<Book>,
    max_bytes: u32,
}

impl VbaTask {
    pub(crate) fn new(state: Shared<Book>, max_bytes: u32) -> Self {
        Self { state, max_bytes }
    }
}

#[napi]
impl Task for VbaTask {
    type Output = Option<VbaProject>;
    type JsValue = Option<VbaProject>;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut guard = lock(&self.state)?;
        let workbook = guard
            .as_mut()
            .ok_or_else(|| error("ERR_CLOSED", "workbook is closed"))?;
        let Some(project) = workbook.vba_project().map_err(|e| error("ERR_VBA", e))? else {
            return Ok(None);
        };

        let mut names = project.get_module_names();
        names.sort_unstable();
        let mut modules = Vec::with_capacity(names.len());
        let mut size = 0_usize;

        for name in names {
            let source = project.get_module(name).map_err(|e| error("ERR_VBA", e))?;
            size = size.saturating_add(source.len());
            if size > self.max_bytes as usize {
                return Err(error("ERR_VBA_LIMIT", "VBA source exceeds maxBytes"));
            }
            modules.push(VbaModule {
                name: name.into(),
                source,
            });
        }

        // Reference paths belong to the document's authoring machine. Never resolve,
        // load or execute them on the server that reads this workbook.
        let references = project
            .get_references()
            .iter()
            .map(|reference| VbaReference {
                name: reference.name.clone(),
                description: reference.description.clone(),
                path: reference.path.to_string_lossy().into_owned(),
            })
            .collect();

        Ok(Some(VbaProject {
            modules,
            references,
        }))
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
