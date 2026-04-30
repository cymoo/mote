use crate::util::extractor::Json;
use axum::extract::multipart::MultipartError;
use axum::extract::rejection::{FormRejection, JsonRejection, QueryRejection};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use sqlx::error::ErrorKind;
use std::error::Error;
use std::fmt;
use std::fmt::Debug;
use validator::ValidationErrors;

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Serialize, Debug)]
pub struct ErrorMessage {
    pub code: u16,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug)]
pub enum ApiError {
    BadRequest(String),
    Unauthorized(String),
    NotFound(String),
    ServerError(String),
    TooManyRequests(String),

    PathError(u16, String),

    QueryRejection(QueryRejection),
    JsonRejection(JsonRejection),
    FormRejection(FormRejection),
    MultiPartError(MultipartError),

    ValidationError(ValidationErrors),

    Sqlx(sqlx::Error),

    Anyhow(anyhow::Error),

    Any(ErrorMessage),
}

impl ApiError {
    fn code(&self) -> u16 {
        use ApiError::*;

        match self {
            BadRequest(_) => 400,
            Unauthorized(_) => 401,
            NotFound(_) => 404,
            TooManyRequests(_) => 429,
            PathError(code, _) => *code,
            QueryRejection(_) | JsonRejection(_) | FormRejection(_) | ValidationError(_) => 400,
            ServerError(_) | Sqlx(_) | Anyhow(_) => 500,
            MultiPartError(inner) => inner.status().as_u16(),
            Any(message) => message.code,
        }
    }

    fn reason(&self) -> &str {
        let status_code = StatusCode::from_u16(self.code());
        match status_code {
            Ok(status) => status.canonical_reason().unwrap_or("Unknown error"),
            Err(_e) => "Unknown error",
        }
    }

    fn message(&self) -> Option<String> {
        use super::ApiError::*;
        match self {
            BadRequest(msg) | NotFound(msg) | TooManyRequests(msg) | Unauthorized(msg)
            | ServerError(msg) => Some(msg.clone()),
            PathError(_, message) => Some(message.clone()),
            QueryRejection(error) => Some(error.body_text()),
            JsonRejection(error) => Some(error.body_text()),
            FormRejection(error) => Some(error.body_text()),
            MultiPartError(error) => Some(error.body_text()),
            Sqlx(_) | Anyhow(_) => None,
            ValidationError(err) => Some(err.to_string().replace('\n', "; ")),
            Any(msg) => msg.message.clone(),
        }
    }

    fn to_default_json(&self) -> Response {
        self.to_json(self.code(), self.reason(), self.message().as_deref())
    }

    fn to_json(&self, code: u16, error: &str, message: Option<&str>) -> Response {
        (
            StatusCode::from_u16(code).unwrap(),
            Json(ErrorMessage {
                code,
                error: error.to_string(),
                message: message.map(String::from),
            }),
        )
            .into_response()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        use ApiError::*;
        use ErrorKind::*;

        match self {
            Sqlx(ref error) => {
                tracing::error!("sqlx error: {:?}", error);
                match error {
                    sqlx::Error::Database(dbe) if dbe.constraint().is_some() => match dbe.kind() {
                        UniqueViolation => {
                            self.to_json(409, "Conflict", Some("Unique value already in use"))
                        }
                        ForeignKeyViolation => {
                            self.to_json(400, "Bad Request", Some("Missing related record"))
                        }
                        NotNullViolation => {
                            self.to_json(400, "Bad Request", Some("Missing required field"))
                        }
                        _ => self.to_json(400, "Bad Request", Some("Invalid input value")),
                    },
                    sqlx::Error::RowNotFound => {
                        self.to_json(404, "Not Found", Some("Data not found"))
                    }
                    _ => self.to_default_json(),
                }
            }
            Anyhow(ref error) => {
                tracing::error!("generic error: {:?}", error);
                self.to_default_json()
            }
            _ => self.to_default_json(),
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.reason())
    }
}

impl Error for ApiError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        use super::ApiError::*;
        match self {
            QueryRejection(err) => Some(err),
            JsonRejection(err) => Some(err),
            FormRejection(err) => Some(err),
            MultiPartError(err) => Some(err),
            ValidationError(err) => Some(err),
            Sqlx(err) => Some(err),
            Anyhow(err) => err.source(),
            _ => None,
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        ApiError::Sqlx(err)
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        ApiError::Anyhow(err)
    }
}

impl From<QueryRejection> for ApiError {
    fn from(rejection: QueryRejection) -> Self {
        ApiError::QueryRejection(rejection)
    }
}

impl From<JsonRejection> for ApiError {
    fn from(rejection: JsonRejection) -> Self {
        ApiError::JsonRejection(rejection)
    }
}

impl From<FormRejection> for ApiError {
    fn from(rejection: FormRejection) -> Self {
        ApiError::FormRejection(rejection)
    }
}

impl From<MultipartError> for ApiError {
    fn from(err: MultipartError) -> Self {
        ApiError::MultiPartError(err)
    }
}

impl From<ValidationErrors> for ApiError {
    fn from(err: ValidationErrors) -> Self {
        ApiError::ValidationError(err)
    }
}

pub fn bad_request(msg: &str) -> ApiError {
    ApiError::BadRequest(msg.to_string())
}

pub fn not_found(msg: &str) -> ApiError {
    ApiError::NotFound(msg.to_string())
}

pub fn any_error(code: u16, error: &str, message: Option<&str>) -> ApiError {
    ApiError::Any(ErrorMessage {
        code,
        error: error.to_string(),
        message: message.map(String::from),
    })
}

impl From<crate::service::drive_service::DriveError> for ApiError {
    fn from(err: crate::service::drive_service::DriveError) -> Self {
        use crate::service::drive_service::DriveError as D;
        match err {
            D::NotFound | D::UploadNotFound | D::ShareNotFound => {
                ApiError::NotFound(err.to_string())
            }
            D::NameConflict => any_error(409, "Conflict", Some(&err.to_string())),
            D::ShareExpired => any_error(410, "Gone", Some(&err.to_string())),
            D::ShareWrongPassword => ApiError::Unauthorized(err.to_string()),
            D::ShareNoPassword => ApiError::BadRequest(err.to_string()),
            D::Cycle
            | D::NotFolder
            | D::InvalidName
            | D::InvalidParent
            | D::ShareInvalidNode
            | D::NotImage
            | D::UploadInvalidRequest
            | D::UploadChunkSize
            | D::UploadChunkOOR
            | D::UploadIncomplete
            | D::UploadFinalSize
            | D::UploadTooLarge => ApiError::BadRequest(err.to_string()),
            D::Io(e) => ApiError::ServerError(format!("io: {}", e)),
            D::Sqlx(e) => ApiError::Sqlx(e),
            D::Other(e) => ApiError::Anyhow(e),
        }
    }
}
