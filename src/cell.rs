use calamine::Data;
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub type CellValue = Either5<String, f64, bool, Null, SpecialValue>;

#[napi(object)]
pub struct SpecialValue {
    pub kind: String,
    pub value: Either<f64, String>,
    /// Wall-clock components: year, month, day, hour, minute, second, millisecond.
    pub calendar: Option<Vec<u32>>,
}

fn special(kind: &str, value: Either<f64, String>, calendar: Option<Vec<u32>>) -> CellValue {
    Either5::E(SpecialValue {
        kind: kind.into(),
        value,
        calendar,
    })
}
pub(crate) fn cell(value: &Data) -> CellValue {
    match value {
        Data::String(value) => Either5::A(value.clone()),
        Data::Int(value) if value.unsigned_abs() > 9_007_199_254_740_991 => {
            special("integer", Either::B(value.to_string()), None)
        }
        Data::Int(value) => Either5::B(*value as f64),
        Data::Float(value) => Either5::B(*value),
        Data::Bool(value) => Either5::C(*value),
        Data::Empty => Either5::D(Null),
        Data::Error(value) => special("error", Either::B(value.to_string()), None),
        Data::DateTimeIso(value) => special("datetime-iso", Either::B(value.clone()), None),
        Data::DurationIso(value) => special("duration-iso", Either::B(value.clone()), None),
        Data::DateTime(value) if value.is_duration() => {
            special("duration", Either::A(value.as_f64()), None)
        }
        Data::DateTime(value) => {
            let (y, m, d, h, min, s, ms) = value.to_ymd_hms_milli();
            special(
                "datetime",
                Either::A(value.as_f64()),
                Some(vec![
                    y.into(),
                    m.into(),
                    d.into(),
                    h.into(),
                    min.into(),
                    s.into(),
                    ms.into(),
                ]),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_keep_precision() {
        match cell(&Data::Int(i64::MAX)) {
            Either5::E(SpecialValue {
                kind,
                value: Either::B(value),
                ..
            }) => {
                assert_eq!(kind, "integer");
                assert_eq!(value, "9223372036854775807");
            }
            _ => panic!("large integers must be tagged decimal strings"),
        }
    }

    #[test]
    fn dates_preserve_epochs_and_excel_leap_day() {
        for (serial, is_1904, expected) in [
            (60.0, false, vec![1900, 2, 29, 0, 0, 0, 0]),
            (0.0, true, vec![1904, 1, 1, 0, 0, 0, 0]),
        ] {
            let date = calamine::ExcelDateTime::new(
                serial,
                calamine::ExcelDateTimeType::DateTime,
                is_1904,
            );
            match cell(&Data::DateTime(date)) {
                Either5::E(SpecialValue { calendar, .. }) => assert_eq!(calendar, Some(expected)),
                _ => panic!("date must retain calendar components"),
            }
        }
    }
}
