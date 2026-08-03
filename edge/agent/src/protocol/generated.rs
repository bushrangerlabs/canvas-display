// GENERATED FILE — DO NOT EDIT.
// Source: contracts/device/v1/control-message.schema.json
// Regenerate with: npm run contracts:generate:rust

/// Error types.
pub mod error {
    /// Error from a `TryFrom` or `FromStr` implementation.
    pub struct ConversionError(::std::borrow::Cow<'static, str>);
    impl ::std::error::Error for ConversionError {}
    impl ::std::fmt::Display for ConversionError {
        fn fmt(
            &self,
            f: &mut ::std::fmt::Formatter<'_>,
        ) -> Result<(), ::std::fmt::Error> {
            ::std::fmt::Display::fmt(&self.0, f)
        }
    }
    impl ::std::fmt::Debug for ConversionError {
        fn fmt(
            &self,
            f: &mut ::std::fmt::Formatter<'_>,
        ) -> Result<(), ::std::fmt::Error> {
            ::std::fmt::Debug::fmt(&self.0, f)
        }
    }
    impl From<&'static str> for ConversionError {
        fn from(value: &'static str) -> Self {
            Self(value.into())
        }
    }
    impl From<String> for ConversionError {
        fn from(value: String) -> Self {
            Self(value.into())
        }
    }
}
///`AgentInfo`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "AgentInfo",
///  "type": "object",
///  "required": [
///    "architecture",
///    "platform",
///    "version"
///  ],
///  "properties": {
///    "architecture": {
///      "enum": [
///        "amd64",
///        "arm64"
///      ]
///    },
///    "platform": {
///      "const": "linux"
///    },
///    "version": {
///      "type": "string",
///      "maxLength": 64,
///      "minLength": 1
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct AgentInfo {
    pub architecture: AgentInfoArchitecture,
    pub platform: ::serde_json::Value,
    pub version: AgentInfoVersion,
}
///`AgentInfoArchitecture`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "amd64",
///    "arm64"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum AgentInfoArchitecture {
    #[serde(rename = "amd64")]
    Amd64,
    #[serde(rename = "arm64")]
    Arm64,
}
impl ::std::fmt::Display for AgentInfoArchitecture {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Amd64 => f.write_str("amd64"),
            Self::Arm64 => f.write_str("arm64"),
        }
    }
}
impl ::std::str::FromStr for AgentInfoArchitecture {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "amd64" => Ok(Self::Amd64),
            "arm64" => Ok(Self::Arm64),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for AgentInfoArchitecture {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for AgentInfoArchitecture {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for AgentInfoArchitecture {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`AgentInfoVersion`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 64,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct AgentInfoVersion(::std::string::String);
impl ::std::ops::Deref for AgentInfoVersion {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<AgentInfoVersion> for ::std::string::String {
    fn from(value: AgentInfoVersion) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for AgentInfoVersion {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 64usize {
            return Err("longer than 64 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for AgentInfoVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for AgentInfoVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for AgentInfoVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for AgentInfoVersion {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandCancelled`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CommandCancelled",
///  "type": "object",
///  "required": [
///    "correlation_id",
///    "message_id",
///    "payload",
///    "payload_version",
///    "protocol",
///    "sent_at",
///    "sequence",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "payload": {
///      "$ref": "#/definitions/CommandReceiptPayload"
///    },
///    "payload_version": {
///      "const": 1
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "command.cancelled"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandCancelled {
    pub correlation_id: ::uuid::Uuid,
    pub message_id: ::uuid::Uuid,
    pub payload: CommandReceiptPayload,
    pub payload_version: ::serde_json::Value,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub sequence: ::std::num::NonZeroU64,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`CommandCompleted`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CommandCompleted",
///  "type": "object",
///  "required": [
///    "correlation_id",
///    "message_id",
///    "payload",
///    "payload_version",
///    "protocol",
///    "sent_at",
///    "sequence",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "payload": {
///      "allOf": [
///        {
///          "$ref": "#/definitions/CommandReceiptPayload"
///        },
///        {
///          "type": "object",
///          "required": [
///            "replayed",
///            "result"
///          ],
///          "properties": {
///            "replayed": {
///              "type": "boolean"
///            },
///            "result": {
///              "type": "object",
///              "required": [
///                "echoed"
///              ],
///              "properties": {
///                "echoed": {
///                  "type": "string"
///                }
///              },
///              "additionalProperties": true
///            }
///          }
///        }
///      ]
///    },
///    "payload_version": {
///      "const": 1
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "command.completed"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandCompleted {
    pub correlation_id: ::uuid::Uuid,
    pub message_id: ::uuid::Uuid,
    pub payload: CommandCompletedPayload,
    pub payload_version: ::serde_json::Value,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub sequence: ::std::num::NonZeroU64,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`CommandCompletedPayload`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "allOf": [
///    {
///      "$ref": "#/definitions/CommandReceiptPayload"
///    },
///    {
///      "type": "object",
///      "required": [
///        "replayed",
///        "result"
///      ],
///      "properties": {
///        "replayed": {
///          "type": "boolean"
///        },
///        "result": {
///          "type": "object",
///          "required": [
///            "echoed"
///          ],
///          "properties": {
///            "echoed": {
///              "type": "string"
///            }
///          },
///          "additionalProperties": true
///        }
///      }
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandCompletedPayload {
    pub command_id: ::uuid::Uuid,
    pub idempotency_key: CommandCompletedPayloadIdempotencyKey,
    pub replayed: bool,
    pub request_digest: Sha256Digest,
    pub result: CommandCompletedPayloadResult,
}
///`CommandCompletedPayloadIdempotencyKey`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandCompletedPayloadIdempotencyKey(::std::string::String);
impl ::std::ops::Deref for CommandCompletedPayloadIdempotencyKey {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandCompletedPayloadIdempotencyKey>
for ::std::string::String {
    fn from(value: CommandCompletedPayloadIdempotencyKey) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandCompletedPayloadIdempotencyKey {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandCompletedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for CommandCompletedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for CommandCompletedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandCompletedPayloadIdempotencyKey {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandCompletedPayloadResult`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "required": [
///    "echoed"
///  ],
///  "properties": {
///    "echoed": {
///      "type": "string"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandCompletedPayloadResult {
    pub echoed: ::std::string::String,
}
///`CommandFailed`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CommandFailed",
///  "type": "object",
///  "required": [
///    "correlation_id",
///    "message_id",
///    "payload",
///    "payload_version",
///    "protocol",
///    "sent_at",
///    "sequence",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "payload": {
///      "allOf": [
///        {
///          "$ref": "#/definitions/CommandReceiptPayload"
///        },
///        {
///          "type": "object",
///          "required": [
///            "code",
///            "message",
///            "retryable"
///          ],
///          "properties": {
///            "code": {
///              "type": "string",
///              "maxLength": 128,
///              "minLength": 1
///            },
///            "message": {
///              "type": "string",
///              "maxLength": 512,
///              "minLength": 1
///            },
///            "retryable": {
///              "type": "boolean"
///            }
///          }
///        }
///      ]
///    },
///    "payload_version": {
///      "const": 1
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "command.failed"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandFailed {
    pub correlation_id: ::uuid::Uuid,
    pub message_id: ::uuid::Uuid,
    pub payload: CommandFailedPayload,
    pub payload_version: ::serde_json::Value,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub sequence: ::std::num::NonZeroU64,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`CommandFailedPayload`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "allOf": [
///    {
///      "$ref": "#/definitions/CommandReceiptPayload"
///    },
///    {
///      "type": "object",
///      "required": [
///        "code",
///        "message",
///        "retryable"
///      ],
///      "properties": {
///        "code": {
///          "type": "string",
///          "maxLength": 128,
///          "minLength": 1
///        },
///        "message": {
///          "type": "string",
///          "maxLength": 512,
///          "minLength": 1
///        },
///        "retryable": {
///          "type": "boolean"
///        }
///      }
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandFailedPayload {
    pub code: CommandFailedPayloadCode,
    pub command_id: ::uuid::Uuid,
    pub idempotency_key: CommandFailedPayloadIdempotencyKey,
    pub message: CommandFailedPayloadMessage,
    pub request_digest: Sha256Digest,
    pub retryable: bool,
}
///`CommandFailedPayloadCode`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandFailedPayloadCode(::std::string::String);
impl ::std::ops::Deref for CommandFailedPayloadCode {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandFailedPayloadCode> for ::std::string::String {
    fn from(value: CommandFailedPayloadCode) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandFailedPayloadCode {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandFailedPayloadCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for CommandFailedPayloadCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CommandFailedPayloadCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandFailedPayloadCode {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandFailedPayloadIdempotencyKey`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandFailedPayloadIdempotencyKey(::std::string::String);
impl ::std::ops::Deref for CommandFailedPayloadIdempotencyKey {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandFailedPayloadIdempotencyKey> for ::std::string::String {
    fn from(value: CommandFailedPayloadIdempotencyKey) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandFailedPayloadIdempotencyKey {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandFailedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for CommandFailedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for CommandFailedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandFailedPayloadIdempotencyKey {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandFailedPayloadMessage`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 512,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandFailedPayloadMessage(::std::string::String);
impl ::std::ops::Deref for CommandFailedPayloadMessage {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandFailedPayloadMessage> for ::std::string::String {
    fn from(value: CommandFailedPayloadMessage) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandFailedPayloadMessage {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 512usize {
            return Err("longer than 512 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandFailedPayloadMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for CommandFailedPayloadMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CommandFailedPayloadMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandFailedPayloadMessage {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandReceiptPayload`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CommandReceiptPayload",
///  "type": "object",
///  "required": [
///    "command_id",
///    "idempotency_key",
///    "request_digest"
///  ],
///  "properties": {
///    "command_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "idempotency_key": {
///      "type": "string",
///      "maxLength": 128,
///      "minLength": 1
///    },
///    "request_digest": {
///      "$ref": "#/definitions/Sha256Digest"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandReceiptPayload {
    pub command_id: ::uuid::Uuid,
    pub idempotency_key: CommandReceiptPayloadIdempotencyKey,
    pub request_digest: Sha256Digest,
}
///`CommandReceiptPayloadIdempotencyKey`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandReceiptPayloadIdempotencyKey(::std::string::String);
impl ::std::ops::Deref for CommandReceiptPayloadIdempotencyKey {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandReceiptPayloadIdempotencyKey>
for ::std::string::String {
    fn from(value: CommandReceiptPayloadIdempotencyKey) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandReceiptPayloadIdempotencyKey {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandReceiptPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for CommandReceiptPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for CommandReceiptPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandReceiptPayloadIdempotencyKey {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandReceived`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CommandReceived",
///  "type": "object",
///  "required": [
///    "correlation_id",
///    "message_id",
///    "payload",
///    "payload_version",
///    "protocol",
///    "sent_at",
///    "sequence",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "payload": {
///      "allOf": [
///        {
///          "$ref": "#/definitions/CommandReceiptPayload"
///        },
///        {
///          "type": "object",
///          "required": [
///            "duplicate"
///          ],
///          "properties": {
///            "duplicate": {
///              "type": "boolean"
///            }
///          }
///        }
///      ]
///    },
///    "payload_version": {
///      "const": 1
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "command.received"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandReceived {
    pub correlation_id: ::uuid::Uuid,
    pub message_id: ::uuid::Uuid,
    pub payload: CommandReceivedPayload,
    pub payload_version: ::serde_json::Value,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub sequence: ::std::num::NonZeroU64,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`CommandReceivedPayload`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "allOf": [
///    {
///      "$ref": "#/definitions/CommandReceiptPayload"
///    },
///    {
///      "type": "object",
///      "required": [
///        "duplicate"
///      ],
///      "properties": {
///        "duplicate": {
///          "type": "boolean"
///        }
///      }
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandReceivedPayload {
    pub command_id: ::uuid::Uuid,
    pub duplicate: bool,
    pub idempotency_key: CommandReceivedPayloadIdempotencyKey,
    pub request_digest: Sha256Digest,
}
///`CommandReceivedPayloadIdempotencyKey`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandReceivedPayloadIdempotencyKey(::std::string::String);
impl ::std::ops::Deref for CommandReceivedPayloadIdempotencyKey {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandReceivedPayloadIdempotencyKey>
for ::std::string::String {
    fn from(value: CommandReceivedPayloadIdempotencyKey) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandReceivedPayloadIdempotencyKey {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandReceivedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for CommandReceivedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for CommandReceivedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandReceivedPayloadIdempotencyKey {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandRejected`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CommandRejected",
///  "type": "object",
///  "required": [
///    "correlation_id",
///    "message_id",
///    "payload",
///    "payload_version",
///    "protocol",
///    "sent_at",
///    "sequence",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "payload": {
///      "allOf": [
///        {
///          "$ref": "#/definitions/CommandReceiptPayload"
///        },
///        {
///          "type": "object",
///          "required": [
///            "code",
///            "message"
///          ],
///          "properties": {
///            "code": {
///              "enum": [
///                "idempotency_conflict",
///                "expired",
///                "clock_untrusted",
///                "unsupported",
///                "precondition_failed"
///              ]
///            },
///            "message": {
///              "type": "string",
///              "maxLength": 512,
///              "minLength": 1
///            }
///          }
///        }
///      ]
///    },
///    "payload_version": {
///      "const": 1
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "command.rejected"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandRejected {
    pub correlation_id: ::uuid::Uuid,
    pub message_id: ::uuid::Uuid,
    pub payload: CommandRejectedPayload,
    pub payload_version: ::serde_json::Value,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub sequence: ::std::num::NonZeroU64,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`CommandRejectedPayload`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "allOf": [
///    {
///      "$ref": "#/definitions/CommandReceiptPayload"
///    },
///    {
///      "type": "object",
///      "required": [
///        "code",
///        "message"
///      ],
///      "properties": {
///        "code": {
///          "enum": [
///            "idempotency_conflict",
///            "expired",
///            "clock_untrusted",
///            "unsupported",
///            "precondition_failed"
///          ]
///        },
///        "message": {
///          "type": "string",
///          "maxLength": 512,
///          "minLength": 1
///        }
///      }
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandRejectedPayload {
    pub code: CommandRejectedPayloadCode,
    pub command_id: ::uuid::Uuid,
    pub idempotency_key: CommandRejectedPayloadIdempotencyKey,
    pub message: CommandRejectedPayloadMessage,
    pub request_digest: Sha256Digest,
}
///`CommandRejectedPayloadCode`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "idempotency_conflict",
///    "expired",
///    "clock_untrusted",
///    "unsupported",
///    "precondition_failed"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum CommandRejectedPayloadCode {
    #[serde(rename = "idempotency_conflict")]
    IdempotencyConflict,
    #[serde(rename = "expired")]
    Expired,
    #[serde(rename = "clock_untrusted")]
    ClockUntrusted,
    #[serde(rename = "unsupported")]
    Unsupported,
    #[serde(rename = "precondition_failed")]
    PreconditionFailed,
}
impl ::std::fmt::Display for CommandRejectedPayloadCode {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::IdempotencyConflict => f.write_str("idempotency_conflict"),
            Self::Expired => f.write_str("expired"),
            Self::ClockUntrusted => f.write_str("clock_untrusted"),
            Self::Unsupported => f.write_str("unsupported"),
            Self::PreconditionFailed => f.write_str("precondition_failed"),
        }
    }
}
impl ::std::str::FromStr for CommandRejectedPayloadCode {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "idempotency_conflict" => Ok(Self::IdempotencyConflict),
            "expired" => Ok(Self::Expired),
            "clock_untrusted" => Ok(Self::ClockUntrusted),
            "unsupported" => Ok(Self::Unsupported),
            "precondition_failed" => Ok(Self::PreconditionFailed),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for CommandRejectedPayloadCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for CommandRejectedPayloadCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CommandRejectedPayloadCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`CommandRejectedPayloadIdempotencyKey`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandRejectedPayloadIdempotencyKey(::std::string::String);
impl ::std::ops::Deref for CommandRejectedPayloadIdempotencyKey {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandRejectedPayloadIdempotencyKey>
for ::std::string::String {
    fn from(value: CommandRejectedPayloadIdempotencyKey) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandRejectedPayloadIdempotencyKey {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandRejectedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for CommandRejectedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for CommandRejectedPayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandRejectedPayloadIdempotencyKey {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandRejectedPayloadMessage`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 512,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandRejectedPayloadMessage(::std::string::String);
impl ::std::ops::Deref for CommandRejectedPayloadMessage {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandRejectedPayloadMessage> for ::std::string::String {
    fn from(value: CommandRejectedPayloadMessage) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandRejectedPayloadMessage {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 512usize {
            return Err("longer than 512 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandRejectedPayloadMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for CommandRejectedPayloadMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CommandRejectedPayloadMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandRejectedPayloadMessage {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandUnknownOutcome`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CommandUnknownOutcome",
///  "type": "object",
///  "required": [
///    "correlation_id",
///    "message_id",
///    "payload",
///    "payload_version",
///    "protocol",
///    "sent_at",
///    "sequence",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "payload": {
///      "allOf": [
///        {
///          "$ref": "#/definitions/CommandReceiptPayload"
///        },
///        {
///          "type": "object",
///          "required": [
///            "message"
///          ],
///          "properties": {
///            "message": {
///              "type": "string",
///              "maxLength": 512,
///              "minLength": 1
///            }
///          }
///        }
///      ]
///    },
///    "payload_version": {
///      "const": 1
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "command.unknown_outcome"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandUnknownOutcome {
    pub correlation_id: ::uuid::Uuid,
    pub message_id: ::uuid::Uuid,
    pub payload: CommandUnknownOutcomePayload,
    pub payload_version: ::serde_json::Value,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub sequence: ::std::num::NonZeroU64,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`CommandUnknownOutcomePayload`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "allOf": [
///    {
///      "$ref": "#/definitions/CommandReceiptPayload"
///    },
///    {
///      "type": "object",
///      "required": [
///        "message"
///      ],
///      "properties": {
///        "message": {
///          "type": "string",
///          "maxLength": 512,
///          "minLength": 1
///        }
///      }
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandUnknownOutcomePayload {
    pub command_id: ::uuid::Uuid,
    pub idempotency_key: CommandUnknownOutcomePayloadIdempotencyKey,
    pub message: CommandUnknownOutcomePayloadMessage,
    pub request_digest: Sha256Digest,
}
///`CommandUnknownOutcomePayloadIdempotencyKey`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandUnknownOutcomePayloadIdempotencyKey(::std::string::String);
impl ::std::ops::Deref for CommandUnknownOutcomePayloadIdempotencyKey {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandUnknownOutcomePayloadIdempotencyKey>
for ::std::string::String {
    fn from(value: CommandUnknownOutcomePayloadIdempotencyKey) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandUnknownOutcomePayloadIdempotencyKey {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandUnknownOutcomePayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for CommandUnknownOutcomePayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for CommandUnknownOutcomePayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandUnknownOutcomePayloadIdempotencyKey {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CommandUnknownOutcomePayloadMessage`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 512,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandUnknownOutcomePayloadMessage(::std::string::String);
impl ::std::ops::Deref for CommandUnknownOutcomePayloadMessage {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandUnknownOutcomePayloadMessage>
for ::std::string::String {
    fn from(value: CommandUnknownOutcomePayloadMessage) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandUnknownOutcomePayloadMessage {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 512usize {
            return Err("longer than 512 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandUnknownOutcomePayloadMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for CommandUnknownOutcomePayloadMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for CommandUnknownOutcomePayloadMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandUnknownOutcomePayloadMessage {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`CoreHeartbeat`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CoreHeartbeat",
///  "type": "object",
///  "required": [
///    "last_received_sequence",
///    "protocol",
///    "sent_at",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "last_received_sequence": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "core.heartbeat"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CoreHeartbeat {
    pub last_received_sequence: u64,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`CoreWelcome`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CoreWelcome",
///  "type": "object",
///  "required": [
///    "core_time",
///    "desired_revision",
///    "heartbeat_seconds",
///    "message_id",
///    "protocol",
///    "resume",
///    "sent_at",
///    "session_id",
///    "type"
///  ],
///  "properties": {
///    "core_time": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "desired_revision": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "heartbeat_seconds": {
///      "type": "integer",
///      "maximum": 300.0,
///      "minimum": 5.0
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "protocol": {
///      "const": 1
///    },
///    "resume": {
///      "type": "object",
///      "required": [
///        "accepted",
///        "core_stream_epoch",
///        "edge_stream_epoch",
///        "next_core_sequence"
///      ],
///      "properties": {
///        "accepted": {
///          "type": "boolean"
///        },
///        "core_stream_epoch": {
///          "$ref": "#/definitions/Uuid"
///        },
///        "edge_stream_epoch": {
///          "$ref": "#/definitions/Uuid"
///        },
///        "next_core_sequence": {
///          "type": "integer",
///          "minimum": 1.0
///        }
///      },
///      "additionalProperties": true
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "session_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "core.welcome"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CoreWelcome {
    pub core_time: Timestamp,
    pub desired_revision: u64,
    pub heartbeat_seconds: i64,
    pub message_id: ::uuid::Uuid,
    pub protocol: ::serde_json::Value,
    pub resume: CoreWelcomeResume,
    pub sent_at: Timestamp,
    pub session_id: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`CoreWelcomeResume`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "required": [
///    "accepted",
///    "core_stream_epoch",
///    "edge_stream_epoch",
///    "next_core_sequence"
///  ],
///  "properties": {
///    "accepted": {
///      "type": "boolean"
///    },
///    "core_stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "edge_stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "next_core_sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CoreWelcomeResume {
    pub accepted: bool,
    pub core_stream_epoch: ::uuid::Uuid,
    pub edge_stream_epoch: ::uuid::Uuid,
    pub next_core_sequence: ::std::num::NonZeroU64,
}
///`DesiredState`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "DesiredState",
///  "type": "object",
///  "properties": {
///    "audio": {
///      "type": "object",
///      "properties": {
///        "volume": {
///          "type": "integer",
///          "maximum": 100.0,
///          "minimum": 0.0
///        }
///      },
///      "additionalProperties": true
///    },
///    "display": {
///      "type": "object",
///      "properties": {
///        "brightness": {
///          "type": "integer",
///          "maximum": 100.0,
///          "minimum": 0.0
///        },
///        "power": {
///          "enum": [
///            "on",
///            "off"
///          ]
///        }
///      },
///      "additionalProperties": true
///    },
///    "scene": {
///      "type": "object",
///      "required": [
///        "revision_id"
///      ],
///      "properties": {
///        "page": {
///          "description": "Optional inline page document for renderers that do not share Core storage.",
///          "type": "object",
///          "additionalProperties": true
///        },
///        "revision_id": {
///          "type": "string",
///          "maxLength": 255,
///          "minLength": 1
///        }
///      },
///      "additionalProperties": true
///    },
///    "update": {
///      "type": "object",
///      "properties": {
///        "channel": {
///          "type": "string",
///          "maxLength": 64,
///          "minLength": 1
///        }
///      },
///      "additionalProperties": true
///    },
///    "voice": {
///      "type": "object",
///      "properties": {
///        "enabled": {
///          "type": "boolean"
///        },
///        "wake_word": {
///          "type": "string",
///          "maxLength": 128,
///          "minLength": 1
///        }
///      },
///      "additionalProperties": true
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct DesiredState {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub audio: ::std::option::Option<DesiredStateAudio>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub display: ::std::option::Option<DesiredStateDisplay>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub scene: ::std::option::Option<DesiredStateScene>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub update: ::std::option::Option<DesiredStateUpdate>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub voice: ::std::option::Option<DesiredStateVoice>,
}
impl ::std::default::Default for DesiredState {
    fn default() -> Self {
        Self {
            audio: Default::default(),
            display: Default::default(),
            scene: Default::default(),
            update: Default::default(),
            voice: Default::default(),
        }
    }
}
///`DesiredStateAudio`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "properties": {
///    "volume": {
///      "type": "integer",
///      "maximum": 100.0,
///      "minimum": 0.0
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct DesiredStateAudio {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub volume: ::std::option::Option<i64>,
}
impl ::std::default::Default for DesiredStateAudio {
    fn default() -> Self {
        Self { volume: Default::default() }
    }
}
///`DesiredStateDisplay`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "properties": {
///    "brightness": {
///      "type": "integer",
///      "maximum": 100.0,
///      "minimum": 0.0
///    },
///    "power": {
///      "enum": [
///        "on",
///        "off"
///      ]
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct DesiredStateDisplay {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub brightness: ::std::option::Option<i64>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub power: ::std::option::Option<DesiredStateDisplayPower>,
}
impl ::std::default::Default for DesiredStateDisplay {
    fn default() -> Self {
        Self {
            brightness: Default::default(),
            power: Default::default(),
        }
    }
}
///`DesiredStateDisplayPower`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "on",
///    "off"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum DesiredStateDisplayPower {
    #[serde(rename = "on")]
    On,
    #[serde(rename = "off")]
    Off,
}
impl ::std::fmt::Display for DesiredStateDisplayPower {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::On => f.write_str("on"),
            Self::Off => f.write_str("off"),
        }
    }
}
impl ::std::str::FromStr for DesiredStateDisplayPower {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "on" => Ok(Self::On),
            "off" => Ok(Self::Off),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for DesiredStateDisplayPower {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DesiredStateDisplayPower {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DesiredStateDisplayPower {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`DesiredStateScene`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "required": [
///    "revision_id"
///  ],
///  "properties": {
///    "page": {
///      "description": "Optional inline page document for renderers that do not share Core storage.",
///      "type": "object",
///      "additionalProperties": true
///    },
///    "revision_id": {
///      "type": "string",
///      "maxLength": 255,
///      "minLength": 1
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct DesiredStateScene {
    ///Optional inline page document for renderers that do not share Core storage.
    #[serde(default, skip_serializing_if = "::serde_json::Map::is_empty")]
    pub page: ::serde_json::Map<::std::string::String, ::serde_json::Value>,
    pub revision_id: DesiredStateSceneRevisionId,
}
///`DesiredStateSceneRevisionId`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 255,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DesiredStateSceneRevisionId(::std::string::String);
impl ::std::ops::Deref for DesiredStateSceneRevisionId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DesiredStateSceneRevisionId> for ::std::string::String {
    fn from(value: DesiredStateSceneRevisionId) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DesiredStateSceneRevisionId {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 255usize {
            return Err("longer than 255 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DesiredStateSceneRevisionId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DesiredStateSceneRevisionId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DesiredStateSceneRevisionId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DesiredStateSceneRevisionId {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DesiredStateUpdate`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "properties": {
///    "channel": {
///      "type": "string",
///      "maxLength": 64,
///      "minLength": 1
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct DesiredStateUpdate {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub channel: ::std::option::Option<DesiredStateUpdateChannel>,
}
impl ::std::default::Default for DesiredStateUpdate {
    fn default() -> Self {
        Self {
            channel: Default::default(),
        }
    }
}
///`DesiredStateUpdateChannel`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 64,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DesiredStateUpdateChannel(::std::string::String);
impl ::std::ops::Deref for DesiredStateUpdateChannel {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DesiredStateUpdateChannel> for ::std::string::String {
    fn from(value: DesiredStateUpdateChannel) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DesiredStateUpdateChannel {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 64usize {
            return Err("longer than 64 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DesiredStateUpdateChannel {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DesiredStateUpdateChannel {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DesiredStateUpdateChannel {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DesiredStateUpdateChannel {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DesiredStateVoice`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "properties": {
///    "enabled": {
///      "type": "boolean"
///    },
///    "wake_word": {
///      "type": "string",
///      "maxLength": 128,
///      "minLength": 1
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct DesiredStateVoice {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub enabled: ::std::option::Option<bool>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub wake_word: ::std::option::Option<DesiredStateVoiceWakeWord>,
}
impl ::std::default::Default for DesiredStateVoice {
    fn default() -> Self {
        Self {
            enabled: Default::default(),
            wake_word: Default::default(),
        }
    }
}
///`DesiredStateVoiceWakeWord`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DesiredStateVoiceWakeWord(::std::string::String);
impl ::std::ops::Deref for DesiredStateVoiceWakeWord {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DesiredStateVoiceWakeWord> for ::std::string::String {
    fn from(value: DesiredStateVoiceWakeWord) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DesiredStateVoiceWakeWord {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DesiredStateVoiceWakeWord {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DesiredStateVoiceWakeWord {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DesiredStateVoiceWakeWord {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DesiredStateVoiceWakeWord {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DeviceCredential`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "DeviceCredential",
///  "type": "object",
///  "required": [
///    "device_id",
///    "expires_at_unix_ms",
///    "format",
///    "installation_id",
///    "issued_at_unix_ms",
///    "issuer_id",
///    "public_key_fingerprint",
///    "security_epoch",
///    "serial"
///  ],
///  "properties": {
///    "device_id": {
///      "type": "string",
///      "maxLength": 255,
///      "minLength": 1
///    },
///    "expires_at_unix_ms": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "format": {
///      "const": "canvas-phase0-device-credential-v1"
///    },
///    "installation_id": {
///      "type": "string",
///      "maxLength": 255,
///      "minLength": 1
///    },
///    "issued_at_unix_ms": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "issuer_id": {
///      "type": "string",
///      "maxLength": 128,
///      "minLength": 1
///    },
///    "public_key_fingerprint": {
///      "type": "string",
///      "maxLength": 128,
///      "minLength": 1
///    },
///    "security_epoch": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "serial": {
///      "type": "integer",
///      "minimum": 1.0
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct DeviceCredential {
    pub device_id: DeviceCredentialDeviceId,
    pub expires_at_unix_ms: u64,
    pub format: ::serde_json::Value,
    pub installation_id: DeviceCredentialInstallationId,
    pub issued_at_unix_ms: u64,
    pub issuer_id: DeviceCredentialIssuerId,
    pub public_key_fingerprint: DeviceCredentialPublicKeyFingerprint,
    pub security_epoch: ::std::num::NonZeroU64,
    pub serial: ::std::num::NonZeroU64,
}
///`DeviceCredentialDeviceId`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 255,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DeviceCredentialDeviceId(::std::string::String);
impl ::std::ops::Deref for DeviceCredentialDeviceId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DeviceCredentialDeviceId> for ::std::string::String {
    fn from(value: DeviceCredentialDeviceId) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DeviceCredentialDeviceId {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 255usize {
            return Err("longer than 255 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DeviceCredentialDeviceId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DeviceCredentialDeviceId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DeviceCredentialDeviceId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DeviceCredentialDeviceId {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DeviceCredentialEnvelope`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "DeviceCredentialEnvelope",
///  "type": "object",
///  "required": [
///    "credential",
///    "signature"
///  ],
///  "properties": {
///    "credential": {
///      "$ref": "#/definitions/DeviceCredential"
///    },
///    "signature": {
///      "description": "Base64 Ed25519 signature over the canonical (sorted-key) JSON of the embedded `credential` object, produced by Core's enrollment signing key.",
///      "type": "string",
///      "minLength": 1
///    },
///    "signer_public_key": {
///      "description": "Base64 raw 32-byte Ed25519 public key that produced `signature`. Optional on the wire (Core has its own record of the signing key); included so the Edge can log/verify it without a separate channel.",
///      "type": "string",
///      "minLength": 1
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct DeviceCredentialEnvelope {
    pub credential: DeviceCredential,
    ///Base64 Ed25519 signature over the canonical (sorted-key) JSON of the embedded `credential` object, produced by Core's enrollment signing key.
    pub signature: DeviceCredentialEnvelopeSignature,
    ///Base64 raw 32-byte Ed25519 public key that produced `signature`. Optional on the wire (Core has its own record of the signing key); included so the Edge can log/verify it without a separate channel.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub signer_public_key: ::std::option::Option<
        DeviceCredentialEnvelopeSignerPublicKey,
    >,
}
///Base64 Ed25519 signature over the canonical (sorted-key) JSON of the embedded `credential` object, produced by Core's enrollment signing key.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "description": "Base64 Ed25519 signature over the canonical (sorted-key) JSON of the embedded `credential` object, produced by Core's enrollment signing key.",
///  "type": "string",
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DeviceCredentialEnvelopeSignature(::std::string::String);
impl ::std::ops::Deref for DeviceCredentialEnvelopeSignature {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DeviceCredentialEnvelopeSignature> for ::std::string::String {
    fn from(value: DeviceCredentialEnvelopeSignature) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DeviceCredentialEnvelopeSignature {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DeviceCredentialEnvelopeSignature {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for DeviceCredentialEnvelopeSignature {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for DeviceCredentialEnvelopeSignature {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DeviceCredentialEnvelopeSignature {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///Base64 raw 32-byte Ed25519 public key that produced `signature`. Optional on the wire (Core has its own record of the signing key); included so the Edge can log/verify it without a separate channel.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "description": "Base64 raw 32-byte Ed25519 public key that produced `signature`. Optional on the wire (Core has its own record of the signing key); included so the Edge can log/verify it without a separate channel.",
///  "type": "string",
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DeviceCredentialEnvelopeSignerPublicKey(::std::string::String);
impl ::std::ops::Deref for DeviceCredentialEnvelopeSignerPublicKey {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DeviceCredentialEnvelopeSignerPublicKey>
for ::std::string::String {
    fn from(value: DeviceCredentialEnvelopeSignerPublicKey) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DeviceCredentialEnvelopeSignerPublicKey {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DeviceCredentialEnvelopeSignerPublicKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for DeviceCredentialEnvelopeSignerPublicKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for DeviceCredentialEnvelopeSignerPublicKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DeviceCredentialEnvelopeSignerPublicKey {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DeviceCredentialInstallationId`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 255,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DeviceCredentialInstallationId(::std::string::String);
impl ::std::ops::Deref for DeviceCredentialInstallationId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DeviceCredentialInstallationId> for ::std::string::String {
    fn from(value: DeviceCredentialInstallationId) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DeviceCredentialInstallationId {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 255usize {
            return Err("longer than 255 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DeviceCredentialInstallationId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DeviceCredentialInstallationId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DeviceCredentialInstallationId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DeviceCredentialInstallationId {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DeviceCredentialIssuerId`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DeviceCredentialIssuerId(::std::string::String);
impl ::std::ops::Deref for DeviceCredentialIssuerId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DeviceCredentialIssuerId> for ::std::string::String {
    fn from(value: DeviceCredentialIssuerId) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DeviceCredentialIssuerId {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DeviceCredentialIssuerId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DeviceCredentialIssuerId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DeviceCredentialIssuerId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DeviceCredentialIssuerId {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DeviceCredentialPublicKeyFingerprint`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DeviceCredentialPublicKeyFingerprint(::std::string::String);
impl ::std::ops::Deref for DeviceCredentialPublicKeyFingerprint {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DeviceCredentialPublicKeyFingerprint>
for ::std::string::String {
    fn from(value: DeviceCredentialPublicKeyFingerprint) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DeviceCredentialPublicKeyFingerprint {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DeviceCredentialPublicKeyFingerprint {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for DeviceCredentialPublicKeyFingerprint {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for DeviceCredentialPublicKeyFingerprint {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DeviceCredentialPublicKeyFingerprint {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///Canvas Core to Canvas Edge control-plane message contract.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "$id": "https://schemas.canvas-display.local/device/v1/control-message.schema.json",
///  "title": "DeviceV1ControlMessage",
///  "description": "Canvas Core to Canvas Edge control-plane message contract.",
///  "oneOf": [
///    {
///      "$ref": "#/definitions/EdgeHello"
///    },
///    {
///      "$ref": "#/definitions/CoreWelcome"
///    },
///    {
///      "$ref": "#/definitions/EdgeHeartbeat"
///    },
///    {
///      "$ref": "#/definitions/CoreHeartbeat"
///    },
///    {
///      "$ref": "#/definitions/StreamAck"
///    },
///    {
///      "$ref": "#/definitions/StreamReset"
///    },
///    {
///      "$ref": "#/definitions/StateDesired"
///    },
///    {
///      "$ref": "#/definitions/StateReported"
///    },
///    {
///      "$ref": "#/definitions/DiagnosticsEchoCommandIssue"
///    },
///    {
///      "$ref": "#/definitions/CommandReceived"
///    },
///    {
///      "$ref": "#/definitions/CommandCompleted"
///    },
///    {
///      "$ref": "#/definitions/CommandRejected"
///    },
///    {
///      "$ref": "#/definitions/CommandFailed"
///    },
///    {
///      "$ref": "#/definitions/CommandCancelled"
///    },
///    {
///      "$ref": "#/definitions/CommandUnknownOutcome"
///    },
///    {
///      "$ref": "#/definitions/ProtocolError"
///    }
///  ]
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(untagged)]
pub enum DeviceV1ControlMessage {
    EdgeHello(EdgeHello),
    CoreWelcome(CoreWelcome),
    EdgeHeartbeat(EdgeHeartbeat),
    CoreHeartbeat(CoreHeartbeat),
    StreamAck(StreamAck),
    StreamReset(StreamReset),
    StateDesired(StateDesired),
    StateReported(StateReported),
    DiagnosticsEchoCommandIssue(DiagnosticsEchoCommandIssue),
    CommandReceived(CommandReceived),
    CommandCompleted(CommandCompleted),
    CommandRejected(CommandRejected),
    CommandFailed(CommandFailed),
    CommandCancelled(CommandCancelled),
    CommandUnknownOutcome(CommandUnknownOutcome),
    ProtocolError(ProtocolError),
}
impl ::std::convert::From<EdgeHello> for DeviceV1ControlMessage {
    fn from(value: EdgeHello) -> Self {
        Self::EdgeHello(value)
    }
}
impl ::std::convert::From<CoreWelcome> for DeviceV1ControlMessage {
    fn from(value: CoreWelcome) -> Self {
        Self::CoreWelcome(value)
    }
}
impl ::std::convert::From<EdgeHeartbeat> for DeviceV1ControlMessage {
    fn from(value: EdgeHeartbeat) -> Self {
        Self::EdgeHeartbeat(value)
    }
}
impl ::std::convert::From<CoreHeartbeat> for DeviceV1ControlMessage {
    fn from(value: CoreHeartbeat) -> Self {
        Self::CoreHeartbeat(value)
    }
}
impl ::std::convert::From<StreamAck> for DeviceV1ControlMessage {
    fn from(value: StreamAck) -> Self {
        Self::StreamAck(value)
    }
}
impl ::std::convert::From<StreamReset> for DeviceV1ControlMessage {
    fn from(value: StreamReset) -> Self {
        Self::StreamReset(value)
    }
}
impl ::std::convert::From<StateDesired> for DeviceV1ControlMessage {
    fn from(value: StateDesired) -> Self {
        Self::StateDesired(value)
    }
}
impl ::std::convert::From<StateReported> for DeviceV1ControlMessage {
    fn from(value: StateReported) -> Self {
        Self::StateReported(value)
    }
}
impl ::std::convert::From<DiagnosticsEchoCommandIssue> for DeviceV1ControlMessage {
    fn from(value: DiagnosticsEchoCommandIssue) -> Self {
        Self::DiagnosticsEchoCommandIssue(value)
    }
}
impl ::std::convert::From<CommandReceived> for DeviceV1ControlMessage {
    fn from(value: CommandReceived) -> Self {
        Self::CommandReceived(value)
    }
}
impl ::std::convert::From<CommandCompleted> for DeviceV1ControlMessage {
    fn from(value: CommandCompleted) -> Self {
        Self::CommandCompleted(value)
    }
}
impl ::std::convert::From<CommandRejected> for DeviceV1ControlMessage {
    fn from(value: CommandRejected) -> Self {
        Self::CommandRejected(value)
    }
}
impl ::std::convert::From<CommandFailed> for DeviceV1ControlMessage {
    fn from(value: CommandFailed) -> Self {
        Self::CommandFailed(value)
    }
}
impl ::std::convert::From<CommandCancelled> for DeviceV1ControlMessage {
    fn from(value: CommandCancelled) -> Self {
        Self::CommandCancelled(value)
    }
}
impl ::std::convert::From<CommandUnknownOutcome> for DeviceV1ControlMessage {
    fn from(value: CommandUnknownOutcome) -> Self {
        Self::CommandUnknownOutcome(value)
    }
}
impl ::std::convert::From<ProtocolError> for DeviceV1ControlMessage {
    fn from(value: ProtocolError) -> Self {
        Self::ProtocolError(value)
    }
}
///`DiagnosticsEchoCommandIssue`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "DiagnosticsEchoCommandIssue",
///  "type": "object",
///  "required": [
///    "correlation_id",
///    "expires_at",
///    "message_id",
///    "payload",
///    "payload_version",
///    "protocol",
///    "sent_at",
///    "sequence",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "expires_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "payload": {
///      "type": "object",
///      "required": [
///        "command_id",
///        "created_at",
///        "execution_class",
///        "idempotency_key",
///        "kind",
///        "max_clock_uncertainty_ms",
///        "not_before",
///        "parameters",
///        "request_digest"
///      ],
///      "properties": {
///        "command_id": {
///          "$ref": "#/definitions/Uuid"
///        },
///        "created_at": {
///          "$ref": "#/definitions/Timestamp"
///        },
///        "execution_class": {
///          "const": "replay_safe"
///        },
///        "idempotency_key": {
///          "type": "string",
///          "maxLength": 128,
///          "minLength": 1
///        },
///        "kind": {
///          "const": "diagnostics.echo"
///        },
///        "max_clock_uncertainty_ms": {
///          "type": "integer",
///          "maximum": 300000.0,
///          "minimum": 0.0
///        },
///        "not_before": {
///          "$ref": "#/definitions/Timestamp"
///        },
///        "parameters": {
///          "type": "object",
///          "required": [
///            "message"
///          ],
///          "properties": {
///            "message": {
///              "type": "string",
///              "maxLength": 1024
///            }
///          },
///          "additionalProperties": false
///        },
///        "request_digest": {
///          "$ref": "#/definitions/Sha256Digest"
///        }
///      },
///      "additionalProperties": false
///    },
///    "payload_version": {
///      "const": 1
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "command.issue"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct DiagnosticsEchoCommandIssue {
    pub correlation_id: ::uuid::Uuid,
    pub expires_at: Timestamp,
    pub message_id: ::uuid::Uuid,
    pub payload: DiagnosticsEchoCommandIssuePayload,
    pub payload_version: ::serde_json::Value,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub sequence: ::std::num::NonZeroU64,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`DiagnosticsEchoCommandIssuePayload`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "required": [
///    "command_id",
///    "created_at",
///    "execution_class",
///    "idempotency_key",
///    "kind",
///    "max_clock_uncertainty_ms",
///    "not_before",
///    "parameters",
///    "request_digest"
///  ],
///  "properties": {
///    "command_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "created_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "execution_class": {
///      "const": "replay_safe"
///    },
///    "idempotency_key": {
///      "type": "string",
///      "maxLength": 128,
///      "minLength": 1
///    },
///    "kind": {
///      "const": "diagnostics.echo"
///    },
///    "max_clock_uncertainty_ms": {
///      "type": "integer",
///      "maximum": 300000.0,
///      "minimum": 0.0
///    },
///    "not_before": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "parameters": {
///      "type": "object",
///      "required": [
///        "message"
///      ],
///      "properties": {
///        "message": {
///          "type": "string",
///          "maxLength": 1024
///        }
///      },
///      "additionalProperties": false
///    },
///    "request_digest": {
///      "$ref": "#/definitions/Sha256Digest"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticsEchoCommandIssuePayload {
    pub command_id: ::uuid::Uuid,
    pub created_at: Timestamp,
    pub execution_class: ::serde_json::Value,
    pub idempotency_key: DiagnosticsEchoCommandIssuePayloadIdempotencyKey,
    pub kind: ::serde_json::Value,
    pub max_clock_uncertainty_ms: i64,
    pub not_before: Timestamp,
    pub parameters: DiagnosticsEchoCommandIssuePayloadParameters,
    pub request_digest: Sha256Digest,
}
///`DiagnosticsEchoCommandIssuePayloadIdempotencyKey`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DiagnosticsEchoCommandIssuePayloadIdempotencyKey(::std::string::String);
impl ::std::ops::Deref for DiagnosticsEchoCommandIssuePayloadIdempotencyKey {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DiagnosticsEchoCommandIssuePayloadIdempotencyKey>
for ::std::string::String {
    fn from(value: DiagnosticsEchoCommandIssuePayloadIdempotencyKey) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DiagnosticsEchoCommandIssuePayloadIdempotencyKey {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DiagnosticsEchoCommandIssuePayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for DiagnosticsEchoCommandIssuePayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for DiagnosticsEchoCommandIssuePayloadIdempotencyKey {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de>
for DiagnosticsEchoCommandIssuePayloadIdempotencyKey {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DiagnosticsEchoCommandIssuePayloadParameters`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "required": [
///    "message"
///  ],
///  "properties": {
///    "message": {
///      "type": "string",
///      "maxLength": 1024
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticsEchoCommandIssuePayloadParameters {
    pub message: DiagnosticsEchoCommandIssuePayloadParametersMessage,
}
///`DiagnosticsEchoCommandIssuePayloadParametersMessage`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 1024
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DiagnosticsEchoCommandIssuePayloadParametersMessage(::std::string::String);
impl ::std::ops::Deref for DiagnosticsEchoCommandIssuePayloadParametersMessage {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DiagnosticsEchoCommandIssuePayloadParametersMessage>
for ::std::string::String {
    fn from(value: DiagnosticsEchoCommandIssuePayloadParametersMessage) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DiagnosticsEchoCommandIssuePayloadParametersMessage {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 1024usize {
            return Err("longer than 1024 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str>
for DiagnosticsEchoCommandIssuePayloadParametersMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for DiagnosticsEchoCommandIssuePayloadParametersMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for DiagnosticsEchoCommandIssuePayloadParametersMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de>
for DiagnosticsEchoCommandIssuePayloadParametersMessage {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`Divergence`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "Divergence",
///  "type": "object",
///  "required": [
///    "actual",
///    "desired",
///    "path",
///    "reason"
///  ],
///  "properties": {
///    "actual": {},
///    "desired": {},
///    "path": {
///      "type": "string",
///      "pattern": "^/"
///    },
///    "reason": {
///      "type": "string",
///      "maxLength": 128,
///      "minLength": 1
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct Divergence {
    pub actual: ::serde_json::Value,
    pub desired: ::serde_json::Value,
    pub path: DivergencePath,
    pub reason: DivergenceReason,
}
///`DivergencePath`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "pattern": "^/"
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DivergencePath(::std::string::String);
impl ::std::ops::Deref for DivergencePath {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DivergencePath> for ::std::string::String {
    fn from(value: DivergencePath) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DivergencePath {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
        { ::regress::Regex::new("^/").unwrap() });
        if PATTERN.find(value).is_none() {
            return Err("doesn't match pattern \"^/\"".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DivergencePath {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DivergencePath {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DivergencePath {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DivergencePath {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DivergenceReason`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DivergenceReason(::std::string::String);
impl ::std::ops::Deref for DivergenceReason {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DivergenceReason> for ::std::string::String {
    fn from(value: DivergenceReason) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DivergenceReason {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DivergenceReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DivergenceReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DivergenceReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DivergenceReason {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DomainApplication`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "DomainApplication",
///  "type": "object",
///  "required": [
///    "desired_revision",
///    "status"
///  ],
///  "properties": {
///    "desired_revision": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "reason": {
///      "type": "string",
///      "maxLength": 128,
///      "minLength": 1
///    },
///    "status": {
///      "enum": [
///        "pending",
///        "applied",
///        "diverged",
///        "failed",
///        "unsupported"
///      ]
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct DomainApplication {
    pub desired_revision: u64,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub reason: ::std::option::Option<DomainApplicationReason>,
    pub status: DomainApplicationStatus,
}
///`DomainApplicationReason`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct DomainApplicationReason(::std::string::String);
impl ::std::ops::Deref for DomainApplicationReason {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<DomainApplicationReason> for ::std::string::String {
    fn from(value: DomainApplicationReason) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for DomainApplicationReason {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for DomainApplicationReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DomainApplicationReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DomainApplicationReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for DomainApplicationReason {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`DomainApplicationStatus`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "pending",
///    "applied",
///    "diverged",
///    "failed",
///    "unsupported"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum DomainApplicationStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "applied")]
    Applied,
    #[serde(rename = "diverged")]
    Diverged,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "unsupported")]
    Unsupported,
}
impl ::std::fmt::Display for DomainApplicationStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Pending => f.write_str("pending"),
            Self::Applied => f.write_str("applied"),
            Self::Diverged => f.write_str("diverged"),
            Self::Failed => f.write_str("failed"),
            Self::Unsupported => f.write_str("unsupported"),
        }
    }
}
impl ::std::str::FromStr for DomainApplicationStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "pending" => Ok(Self::Pending),
            "applied" => Ok(Self::Applied),
            "diverged" => Ok(Self::Diverged),
            "failed" => Ok(Self::Failed),
            "unsupported" => Ok(Self::Unsupported),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for DomainApplicationStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for DomainApplicationStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for DomainApplicationStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`EdgeCapabilities`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EdgeCapabilities",
///  "type": "object",
///  "required": [
///    "hardware",
///    "media",
///    "renderer",
///    "voice"
///  ],
///  "properties": {
///    "hardware": {
///      "type": "array",
///      "items": {
///        "type": "string",
///        "minLength": 1
///      },
///      "uniqueItems": true
///    },
///    "media": {
///      "type": "array",
///      "items": {
///        "type": "string",
///        "minLength": 1
///      },
///      "uniqueItems": true
///    },
///    "renderer": {
///      "type": "array",
///      "items": {
///        "type": "string",
///        "minLength": 1
///      },
///      "uniqueItems": true
///    },
///    "voice": {
///      "type": "array",
///      "items": {
///        "type": "string",
///        "minLength": 1
///      },
///      "uniqueItems": true
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct EdgeCapabilities {
    pub hardware: Vec<EdgeCapabilitiesHardwareItem>,
    pub media: Vec<EdgeCapabilitiesMediaItem>,
    pub renderer: Vec<EdgeCapabilitiesRendererItem>,
    pub voice: Vec<EdgeCapabilitiesVoiceItem>,
}
///`EdgeCapabilitiesHardwareItem`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct EdgeCapabilitiesHardwareItem(::std::string::String);
impl ::std::ops::Deref for EdgeCapabilitiesHardwareItem {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EdgeCapabilitiesHardwareItem> for ::std::string::String {
    fn from(value: EdgeCapabilitiesHardwareItem) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EdgeCapabilitiesHardwareItem {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for EdgeCapabilitiesHardwareItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EdgeCapabilitiesHardwareItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EdgeCapabilitiesHardwareItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EdgeCapabilitiesHardwareItem {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`EdgeCapabilitiesMediaItem`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct EdgeCapabilitiesMediaItem(::std::string::String);
impl ::std::ops::Deref for EdgeCapabilitiesMediaItem {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EdgeCapabilitiesMediaItem> for ::std::string::String {
    fn from(value: EdgeCapabilitiesMediaItem) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EdgeCapabilitiesMediaItem {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for EdgeCapabilitiesMediaItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EdgeCapabilitiesMediaItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EdgeCapabilitiesMediaItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EdgeCapabilitiesMediaItem {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`EdgeCapabilitiesRendererItem`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct EdgeCapabilitiesRendererItem(::std::string::String);
impl ::std::ops::Deref for EdgeCapabilitiesRendererItem {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EdgeCapabilitiesRendererItem> for ::std::string::String {
    fn from(value: EdgeCapabilitiesRendererItem) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EdgeCapabilitiesRendererItem {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for EdgeCapabilitiesRendererItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EdgeCapabilitiesRendererItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EdgeCapabilitiesRendererItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EdgeCapabilitiesRendererItem {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`EdgeCapabilitiesVoiceItem`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct EdgeCapabilitiesVoiceItem(::std::string::String);
impl ::std::ops::Deref for EdgeCapabilitiesVoiceItem {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EdgeCapabilitiesVoiceItem> for ::std::string::String {
    fn from(value: EdgeCapabilitiesVoiceItem) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EdgeCapabilitiesVoiceItem {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for EdgeCapabilitiesVoiceItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EdgeCapabilitiesVoiceItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EdgeCapabilitiesVoiceItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EdgeCapabilitiesVoiceItem {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`EdgeHeartbeat`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EdgeHeartbeat",
///  "type": "object",
///  "required": [
///    "last_received_sequence",
///    "protocol",
///    "sent_at",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "last_received_sequence": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "edge.heartbeat"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct EdgeHeartbeat {
    pub last_received_sequence: u64,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`EdgeHello`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EdgeHello",
///  "type": "object",
///  "required": [
///    "agent",
///    "capabilities",
///    "message_id",
///    "protocol",
///    "resume",
///    "sent_at",
///    "type"
///  ],
///  "properties": {
///    "agent": {
///      "$ref": "#/definitions/AgentInfo"
///    },
///    "capabilities": {
///      "$ref": "#/definitions/EdgeCapabilities"
///    },
///    "credential": {
///      "description": "P-003 enrollment gate: optional Phase 0 signed credential issued by Core's enrollment endpoint. When open pairing is OFF, the gateway verifies the Core signature over the canonical credential JSON and matches it to the paired registry. Present on every reconnect after a successful enrollment so the device does not need to re-enroll.",
///      "$ref": "#/definitions/DeviceCredentialEnvelope"
///    },
///    "device_id": {
///      "description": "Optional, NON-AUTHORITATIVE device identifier supplied for bootstrap/diagnostics only (plan doc §12.4). In the production protocol Core derives device identity from the authenticated mTLS connection and MUST treat any payload `device_id` as untrusted; it is ignored for authorization. The bootstrap Device Gateway may record it as a convenience key when no stronger identity exists yet.",
///      "type": "string",
///      "maxLength": 255,
///      "minLength": 1
///    },
///    "installation_id": {
///      "description": "P-003 enrollment gate: optional stable Edge installation identifier. When open pairing is OFF, Core's gateway matches this against the paired `device_credentials` registry to authorize the hello without requiring the full credential block be re-presented on every reconnect.",
///      "type": "string",
///      "maxLength": 255,
///      "minLength": 1
///    },
///    "invitation_token": {
///      "description": "Optional one-time invitation token (P-003 bootstrap). If present and valid, the bootstrap Device Gateway may mark the device paired/known. A plain hello (no token) continues to work exactly as before when open pairing is ON.",
///      "type": "string",
///      "maxLength": 1024,
///      "minLength": 1
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "protocol": {
///      "$ref": "#/definitions/ProtocolRange"
///    },
///    "public_key_fingerprint": {
///      "description": "P-003 enrollment gate: optional SHA-256 hex of the device's raw 32-byte Ed25519 public key (matches `EdgeIdentity::public_key_fingerprint()`). Core recomputes this from the enrolled public key and never trusts it as a self-reported claim; presenting it here lets the gateway match the hello to a paired registry row by fingerprint.",
///      "type": "string",
///      "maxLength": 128,
///      "minLength": 1
///    },
///    "resume": {
///      "$ref": "#/definitions/ResumeCursor"
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "type": {
///      "const": "edge.hello"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct EdgeHello {
    pub agent: AgentInfo,
    pub capabilities: EdgeCapabilities,
    ///P-003 enrollment gate: optional Phase 0 signed credential issued by Core's enrollment endpoint. When open pairing is OFF, the gateway verifies the Core signature over the canonical credential JSON and matches it to the paired registry. Present on every reconnect after a successful enrollment so the device does not need to re-enroll.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub credential: ::std::option::Option<DeviceCredentialEnvelope>,
    ///Optional, NON-AUTHORITATIVE device identifier supplied for bootstrap/diagnostics only (plan doc §12.4). In the production protocol Core derives device identity from the authenticated mTLS connection and MUST treat any payload `device_id` as untrusted; it is ignored for authorization. The bootstrap Device Gateway may record it as a convenience key when no stronger identity exists yet.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub device_id: ::std::option::Option<EdgeHelloDeviceId>,
    ///P-003 enrollment gate: optional stable Edge installation identifier. When open pairing is OFF, Core's gateway matches this against the paired `device_credentials` registry to authorize the hello without requiring the full credential block be re-presented on every reconnect.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub installation_id: ::std::option::Option<EdgeHelloInstallationId>,
    ///Optional one-time invitation token (P-003 bootstrap). If present and valid, the bootstrap Device Gateway may mark the device paired/known. A plain hello (no token) continues to work exactly as before when open pairing is ON.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub invitation_token: ::std::option::Option<EdgeHelloInvitationToken>,
    pub message_id: ::uuid::Uuid,
    pub protocol: ProtocolRange,
    ///P-003 enrollment gate: optional SHA-256 hex of the device's raw 32-byte Ed25519 public key (matches `EdgeIdentity::public_key_fingerprint()`). Core recomputes this from the enrolled public key and never trusts it as a self-reported claim; presenting it here lets the gateway match the hello to a paired registry row by fingerprint.
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub public_key_fingerprint: ::std::option::Option<EdgeHelloPublicKeyFingerprint>,
    pub resume: ResumeCursor,
    pub sent_at: Timestamp,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///Optional, NON-AUTHORITATIVE device identifier supplied for bootstrap/diagnostics only (plan doc §12.4). In the production protocol Core derives device identity from the authenticated mTLS connection and MUST treat any payload `device_id` as untrusted; it is ignored for authorization. The bootstrap Device Gateway may record it as a convenience key when no stronger identity exists yet.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "description": "Optional, NON-AUTHORITATIVE device identifier supplied for bootstrap/diagnostics only (plan doc §12.4). In the production protocol Core derives device identity from the authenticated mTLS connection and MUST treat any payload `device_id` as untrusted; it is ignored for authorization. The bootstrap Device Gateway may record it as a convenience key when no stronger identity exists yet.",
///  "type": "string",
///  "maxLength": 255,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct EdgeHelloDeviceId(::std::string::String);
impl ::std::ops::Deref for EdgeHelloDeviceId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EdgeHelloDeviceId> for ::std::string::String {
    fn from(value: EdgeHelloDeviceId) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EdgeHelloDeviceId {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 255usize {
            return Err("longer than 255 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for EdgeHelloDeviceId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EdgeHelloDeviceId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EdgeHelloDeviceId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EdgeHelloDeviceId {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///P-003 enrollment gate: optional stable Edge installation identifier. When open pairing is OFF, Core's gateway matches this against the paired `device_credentials` registry to authorize the hello without requiring the full credential block be re-presented on every reconnect.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "description": "P-003 enrollment gate: optional stable Edge installation identifier. When open pairing is OFF, Core's gateway matches this against the paired `device_credentials` registry to authorize the hello without requiring the full credential block be re-presented on every reconnect.",
///  "type": "string",
///  "maxLength": 255,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct EdgeHelloInstallationId(::std::string::String);
impl ::std::ops::Deref for EdgeHelloInstallationId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EdgeHelloInstallationId> for ::std::string::String {
    fn from(value: EdgeHelloInstallationId) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EdgeHelloInstallationId {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 255usize {
            return Err("longer than 255 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for EdgeHelloInstallationId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EdgeHelloInstallationId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EdgeHelloInstallationId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EdgeHelloInstallationId {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///Optional one-time invitation token (P-003 bootstrap). If present and valid, the bootstrap Device Gateway may mark the device paired/known. A plain hello (no token) continues to work exactly as before when open pairing is ON.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "description": "Optional one-time invitation token (P-003 bootstrap). If present and valid, the bootstrap Device Gateway may mark the device paired/known. A plain hello (no token) continues to work exactly as before when open pairing is ON.",
///  "type": "string",
///  "maxLength": 1024,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct EdgeHelloInvitationToken(::std::string::String);
impl ::std::ops::Deref for EdgeHelloInvitationToken {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EdgeHelloInvitationToken> for ::std::string::String {
    fn from(value: EdgeHelloInvitationToken) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EdgeHelloInvitationToken {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 1024usize {
            return Err("longer than 1024 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for EdgeHelloInvitationToken {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EdgeHelloInvitationToken {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EdgeHelloInvitationToken {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EdgeHelloInvitationToken {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///P-003 enrollment gate: optional SHA-256 hex of the device's raw 32-byte Ed25519 public key (matches `EdgeIdentity::public_key_fingerprint()`). Core recomputes this from the enrolled public key and never trusts it as a self-reported claim; presenting it here lets the gateway match the hello to a paired registry row by fingerprint.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "description": "P-003 enrollment gate: optional SHA-256 hex of the device's raw 32-byte Ed25519 public key (matches `EdgeIdentity::public_key_fingerprint()`). Core recomputes this from the enrolled public key and never trusts it as a self-reported claim; presenting it here lets the gateway match the hello to a paired registry row by fingerprint.",
///  "type": "string",
///  "maxLength": 128,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct EdgeHelloPublicKeyFingerprint(::std::string::String);
impl ::std::ops::Deref for EdgeHelloPublicKeyFingerprint {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EdgeHelloPublicKeyFingerprint> for ::std::string::String {
    fn from(value: EdgeHelloPublicKeyFingerprint) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EdgeHelloPublicKeyFingerprint {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for EdgeHelloPublicKeyFingerprint {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EdgeHelloPublicKeyFingerprint {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EdgeHelloPublicKeyFingerprint {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EdgeHelloPublicKeyFingerprint {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`ProtocolError`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ProtocolError",
///  "type": "object",
///  "required": [
///    "code",
///    "message",
///    "message_id",
///    "protocol",
///    "sent_at",
///    "type"
///  ],
///  "properties": {
///    "code": {
///      "enum": [
///        "invalid_message",
///        "unsupported_protocol",
///        "unknown_message",
///        "idempotency_conflict",
///        "stale_revision",
///        "clock_untrusted",
///        "stream_reset_required"
///      ]
///    },
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "message": {
///      "type": "string",
///      "maxLength": 512,
///      "minLength": 1
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "type": {
///      "const": "protocol.error"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ProtocolError {
    pub code: ProtocolErrorCode,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub correlation_id: ::std::option::Option<::uuid::Uuid>,
    pub message: ProtocolErrorMessage,
    pub message_id: ::uuid::Uuid,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`ProtocolErrorCode`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "invalid_message",
///    "unsupported_protocol",
///    "unknown_message",
///    "idempotency_conflict",
///    "stale_revision",
///    "clock_untrusted",
///    "stream_reset_required"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ProtocolErrorCode {
    #[serde(rename = "invalid_message")]
    InvalidMessage,
    #[serde(rename = "unsupported_protocol")]
    UnsupportedProtocol,
    #[serde(rename = "unknown_message")]
    UnknownMessage,
    #[serde(rename = "idempotency_conflict")]
    IdempotencyConflict,
    #[serde(rename = "stale_revision")]
    StaleRevision,
    #[serde(rename = "clock_untrusted")]
    ClockUntrusted,
    #[serde(rename = "stream_reset_required")]
    StreamResetRequired,
}
impl ::std::fmt::Display for ProtocolErrorCode {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::InvalidMessage => f.write_str("invalid_message"),
            Self::UnsupportedProtocol => f.write_str("unsupported_protocol"),
            Self::UnknownMessage => f.write_str("unknown_message"),
            Self::IdempotencyConflict => f.write_str("idempotency_conflict"),
            Self::StaleRevision => f.write_str("stale_revision"),
            Self::ClockUntrusted => f.write_str("clock_untrusted"),
            Self::StreamResetRequired => f.write_str("stream_reset_required"),
        }
    }
}
impl ::std::str::FromStr for ProtocolErrorCode {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "invalid_message" => Ok(Self::InvalidMessage),
            "unsupported_protocol" => Ok(Self::UnsupportedProtocol),
            "unknown_message" => Ok(Self::UnknownMessage),
            "idempotency_conflict" => Ok(Self::IdempotencyConflict),
            "stale_revision" => Ok(Self::StaleRevision),
            "clock_untrusted" => Ok(Self::ClockUntrusted),
            "stream_reset_required" => Ok(Self::StreamResetRequired),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ProtocolErrorCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ProtocolErrorCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ProtocolErrorCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ProtocolErrorMessage`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 512,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct ProtocolErrorMessage(::std::string::String);
impl ::std::ops::Deref for ProtocolErrorMessage {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<ProtocolErrorMessage> for ::std::string::String {
    fn from(value: ProtocolErrorMessage) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for ProtocolErrorMessage {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 512usize {
            return Err("longer than 512 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for ProtocolErrorMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ProtocolErrorMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ProtocolErrorMessage {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for ProtocolErrorMessage {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`ProtocolRange`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ProtocolRange",
///  "type": "object",
///  "required": [
///    "maximum",
///    "minimum"
///  ],
///  "properties": {
///    "maximum": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "minimum": {
///      "type": "integer",
///      "minimum": 1.0
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ProtocolRange {
    pub maximum: ::std::num::NonZeroU64,
    pub minimum: ::std::num::NonZeroU64,
}
///`ReportedState`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ReportedState",
///  "type": "object",
///  "properties": {
///    "connectivity": {
///      "type": "object",
///      "properties": {
///        "core": {
///          "enum": [
///            "online",
///            "degraded",
///            "offline"
///          ]
///        }
///      },
///      "additionalProperties": true
///    },
///    "display": {
///      "type": "object",
///      "properties": {
///        "brightness": {
///          "type": "integer",
///          "maximum": 100.0,
///          "minimum": 0.0
///        },
///        "power": {
///          "enum": [
///            "on",
///            "off"
///          ]
///        }
///      },
///      "additionalProperties": true
///    },
///    "scene": {
///      "type": "object",
///      "properties": {
///        "revision_id": {
///          "type": "string",
///          "maxLength": 255,
///          "minLength": 1
///        },
///        "status": {
///          "enum": [
///            "staging",
///            "active",
///            "failed",
///            "rolled_back"
///          ]
///        }
///      },
///      "additionalProperties": true
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ReportedState {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub connectivity: ::std::option::Option<ReportedStateConnectivity>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub display: ::std::option::Option<ReportedStateDisplay>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub scene: ::std::option::Option<ReportedStateScene>,
}
impl ::std::default::Default for ReportedState {
    fn default() -> Self {
        Self {
            connectivity: Default::default(),
            display: Default::default(),
            scene: Default::default(),
        }
    }
}
///`ReportedStateConnectivity`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "properties": {
///    "core": {
///      "enum": [
///        "online",
///        "degraded",
///        "offline"
///      ]
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ReportedStateConnectivity {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub core: ::std::option::Option<ReportedStateConnectivityCore>,
}
impl ::std::default::Default for ReportedStateConnectivity {
    fn default() -> Self {
        Self { core: Default::default() }
    }
}
///`ReportedStateConnectivityCore`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "online",
///    "degraded",
///    "offline"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ReportedStateConnectivityCore {
    #[serde(rename = "online")]
    Online,
    #[serde(rename = "degraded")]
    Degraded,
    #[serde(rename = "offline")]
    Offline,
}
impl ::std::fmt::Display for ReportedStateConnectivityCore {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Online => f.write_str("online"),
            Self::Degraded => f.write_str("degraded"),
            Self::Offline => f.write_str("offline"),
        }
    }
}
impl ::std::str::FromStr for ReportedStateConnectivityCore {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "online" => Ok(Self::Online),
            "degraded" => Ok(Self::Degraded),
            "offline" => Ok(Self::Offline),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ReportedStateConnectivityCore {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ReportedStateConnectivityCore {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ReportedStateConnectivityCore {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ReportedStateDisplay`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "properties": {
///    "brightness": {
///      "type": "integer",
///      "maximum": 100.0,
///      "minimum": 0.0
///    },
///    "power": {
///      "enum": [
///        "on",
///        "off"
///      ]
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ReportedStateDisplay {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub brightness: ::std::option::Option<i64>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub power: ::std::option::Option<ReportedStateDisplayPower>,
}
impl ::std::default::Default for ReportedStateDisplay {
    fn default() -> Self {
        Self {
            brightness: Default::default(),
            power: Default::default(),
        }
    }
}
///`ReportedStateDisplayPower`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "on",
///    "off"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ReportedStateDisplayPower {
    #[serde(rename = "on")]
    On,
    #[serde(rename = "off")]
    Off,
}
impl ::std::fmt::Display for ReportedStateDisplayPower {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::On => f.write_str("on"),
            Self::Off => f.write_str("off"),
        }
    }
}
impl ::std::str::FromStr for ReportedStateDisplayPower {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "on" => Ok(Self::On),
            "off" => Ok(Self::Off),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ReportedStateDisplayPower {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ReportedStateDisplayPower {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ReportedStateDisplayPower {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ReportedStateScene`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "properties": {
///    "revision_id": {
///      "type": "string",
///      "maxLength": 255,
///      "minLength": 1
///    },
///    "status": {
///      "enum": [
///        "staging",
///        "active",
///        "failed",
///        "rolled_back"
///      ]
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ReportedStateScene {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub revision_id: ::std::option::Option<ReportedStateSceneRevisionId>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub status: ::std::option::Option<ReportedStateSceneStatus>,
}
impl ::std::default::Default for ReportedStateScene {
    fn default() -> Self {
        Self {
            revision_id: Default::default(),
            status: Default::default(),
        }
    }
}
///`ReportedStateSceneRevisionId`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 255,
///  "minLength": 1
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct ReportedStateSceneRevisionId(::std::string::String);
impl ::std::ops::Deref for ReportedStateSceneRevisionId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<ReportedStateSceneRevisionId> for ::std::string::String {
    fn from(value: ReportedStateSceneRevisionId) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for ReportedStateSceneRevisionId {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 255usize {
            return Err("longer than 255 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for ReportedStateSceneRevisionId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ReportedStateSceneRevisionId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ReportedStateSceneRevisionId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for ReportedStateSceneRevisionId {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`ReportedStateSceneStatus`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "staging",
///    "active",
///    "failed",
///    "rolled_back"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ReportedStateSceneStatus {
    #[serde(rename = "staging")]
    Staging,
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "rolled_back")]
    RolledBack,
}
impl ::std::fmt::Display for ReportedStateSceneStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Staging => f.write_str("staging"),
            Self::Active => f.write_str("active"),
            Self::Failed => f.write_str("failed"),
            Self::RolledBack => f.write_str("rolled_back"),
        }
    }
}
impl ::std::str::FromStr for ReportedStateSceneStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "staging" => Ok(Self::Staging),
            "active" => Ok(Self::Active),
            "failed" => Ok(Self::Failed),
            "rolled_back" => Ok(Self::RolledBack),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ReportedStateSceneStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for ReportedStateSceneStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ReportedStateSceneStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ResumeCursor`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "ResumeCursor",
///  "type": "object",
///  "properties": {
///    "core_stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "edge_stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "last_core_sequence": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "last_edge_sequence_acked": {
///      "type": "integer",
///      "minimum": 0.0
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ResumeCursor {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub core_stream_epoch: ::std::option::Option<::uuid::Uuid>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub edge_stream_epoch: ::std::option::Option<::uuid::Uuid>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub last_core_sequence: ::std::option::Option<u64>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub last_edge_sequence_acked: ::std::option::Option<u64>,
}
impl ::std::default::Default for ResumeCursor {
    fn default() -> Self {
        Self {
            core_stream_epoch: Default::default(),
            edge_stream_epoch: Default::default(),
            last_core_sequence: Default::default(),
            last_edge_sequence_acked: Default::default(),
        }
    }
}
///`Sha256Digest`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "pattern": "^sha256:[0-9a-f]{64}$"
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct Sha256Digest(::std::string::String);
impl ::std::ops::Deref for Sha256Digest {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<Sha256Digest> for ::std::string::String {
    fn from(value: Sha256Digest) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for Sha256Digest {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
        { ::regress::Regex::new("^sha256:[0-9a-f]{64}$").unwrap() });
        if PATTERN.find(value).is_none() {
            return Err("doesn't match pattern \"^sha256:[0-9a-f]{64}$\"".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for Sha256Digest {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for Sha256Digest {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for Sha256Digest {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`StateDesired`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "StateDesired",
///  "type": "object",
///  "required": [
///    "message_id",
///    "payload",
///    "payload_version",
///    "protocol",
///    "sent_at",
///    "sequence",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "payload": {
///      "type": "object",
///      "required": [
///        "authority_epoch",
///        "desired_digest",
///        "revision",
///        "state"
///      ],
///      "properties": {
///        "authority_epoch": {
///          "$ref": "#/definitions/Uuid"
///        },
///        "desired_digest": {
///          "$ref": "#/definitions/Sha256Digest"
///        },
///        "revision": {
///          "type": "integer",
///          "minimum": 1.0
///        },
///        "state": {
///          "$ref": "#/definitions/DesiredState"
///        }
///      },
///      "additionalProperties": true
///    },
///    "payload_version": {
///      "const": 1
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "state.desired"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct StateDesired {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub correlation_id: ::std::option::Option<::uuid::Uuid>,
    pub message_id: ::uuid::Uuid,
    pub payload: StateDesiredPayload,
    pub payload_version: ::serde_json::Value,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub sequence: ::std::num::NonZeroU64,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`StateDesiredPayload`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "required": [
///    "authority_epoch",
///    "desired_digest",
///    "revision",
///    "state"
///  ],
///  "properties": {
///    "authority_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "desired_digest": {
///      "$ref": "#/definitions/Sha256Digest"
///    },
///    "revision": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "state": {
///      "$ref": "#/definitions/DesiredState"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct StateDesiredPayload {
    pub authority_epoch: ::uuid::Uuid,
    pub desired_digest: Sha256Digest,
    pub revision: ::std::num::NonZeroU64,
    pub state: DesiredState,
}
///`StateReported`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "StateReported",
///  "type": "object",
///  "required": [
///    "message_id",
///    "payload",
///    "payload_version",
///    "protocol",
///    "sent_at",
///    "sequence",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "correlation_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "payload": {
///      "type": "object",
///      "required": [
///        "application",
///        "applied_revision",
///        "authority_epoch",
///        "desired_revision",
///        "divergences",
///        "processed_desired_revision",
///        "reported_revision",
///        "state",
///        "status"
///      ],
///      "properties": {
///        "application": {
///          "type": "object",
///          "additionalProperties": {
///            "$ref": "#/definitions/DomainApplication"
///          }
///        },
///        "applied_revision": {
///          "type": "integer",
///          "minimum": 0.0
///        },
///        "authority_epoch": {
///          "$ref": "#/definitions/Uuid"
///        },
///        "desired_revision": {
///          "type": "integer",
///          "minimum": 0.0
///        },
///        "divergences": {
///          "type": "array",
///          "items": {
///            "$ref": "#/definitions/Divergence"
///          }
///        },
///        "processed_desired_revision": {
///          "type": "integer",
///          "minimum": 0.0
///        },
///        "reported_revision": {
///          "type": "integer",
///          "minimum": 1.0
///        },
///        "state": {
///          "$ref": "#/definitions/ReportedState"
///        },
///        "status": {
///          "enum": [
///            "pending",
///            "applied",
///            "partially_applied",
///            "diverged",
///            "failed"
///          ]
///        }
///      },
///      "additionalProperties": true
///    },
///    "payload_version": {
///      "const": 1
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "state.reported"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct StateReported {
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub correlation_id: ::std::option::Option<::uuid::Uuid>,
    pub message_id: ::uuid::Uuid,
    pub payload: StateReportedPayload,
    pub payload_version: ::serde_json::Value,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub sequence: ::std::num::NonZeroU64,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`StateReportedPayload`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "object",
///  "required": [
///    "application",
///    "applied_revision",
///    "authority_epoch",
///    "desired_revision",
///    "divergences",
///    "processed_desired_revision",
///    "reported_revision",
///    "state",
///    "status"
///  ],
///  "properties": {
///    "application": {
///      "type": "object",
///      "additionalProperties": {
///        "$ref": "#/definitions/DomainApplication"
///      }
///    },
///    "applied_revision": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "authority_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "desired_revision": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "divergences": {
///      "type": "array",
///      "items": {
///        "$ref": "#/definitions/Divergence"
///      }
///    },
///    "processed_desired_revision": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "reported_revision": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "state": {
///      "$ref": "#/definitions/ReportedState"
///    },
///    "status": {
///      "enum": [
///        "pending",
///        "applied",
///        "partially_applied",
///        "diverged",
///        "failed"
///      ]
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct StateReportedPayload {
    pub application: ::std::collections::HashMap<
        ::std::string::String,
        DomainApplication,
    >,
    pub applied_revision: u64,
    pub authority_epoch: ::uuid::Uuid,
    pub desired_revision: u64,
    pub divergences: ::std::vec::Vec<Divergence>,
    pub processed_desired_revision: u64,
    pub reported_revision: ::std::num::NonZeroU64,
    pub state: ReportedState,
    pub status: StateReportedPayloadStatus,
}
///`StateReportedPayloadStatus`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "pending",
///    "applied",
///    "partially_applied",
///    "diverged",
///    "failed"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum StateReportedPayloadStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "applied")]
    Applied,
    #[serde(rename = "partially_applied")]
    PartiallyApplied,
    #[serde(rename = "diverged")]
    Diverged,
    #[serde(rename = "failed")]
    Failed,
}
impl ::std::fmt::Display for StateReportedPayloadStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Pending => f.write_str("pending"),
            Self::Applied => f.write_str("applied"),
            Self::PartiallyApplied => f.write_str("partially_applied"),
            Self::Diverged => f.write_str("diverged"),
            Self::Failed => f.write_str("failed"),
        }
    }
}
impl ::std::str::FromStr for StateReportedPayloadStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "pending" => Ok(Self::Pending),
            "applied" => Ok(Self::Applied),
            "partially_applied" => Ok(Self::PartiallyApplied),
            "diverged" => Ok(Self::Diverged),
            "failed" => Ok(Self::Failed),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for StateReportedPayloadStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for StateReportedPayloadStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for StateReportedPayloadStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`StreamAck`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "StreamAck",
///  "type": "object",
///  "required": [
///    "acknowledged_sequence",
///    "protocol",
///    "sent_at",
///    "stream_epoch",
///    "type"
///  ],
///  "properties": {
///    "acknowledged_sequence": {
///      "type": "integer",
///      "minimum": 1.0
///    },
///    "protocol": {
///      "const": 1
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "type": {
///      "const": "stream.ack"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct StreamAck {
    pub acknowledged_sequence: ::std::num::NonZeroU64,
    pub protocol: ::serde_json::Value,
    pub sent_at: Timestamp,
    pub stream_epoch: ::uuid::Uuid,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`StreamReset`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "StreamReset",
///  "type": "object",
///  "required": [
///    "desired_revision",
///    "message_id",
///    "new_stream_epoch",
///    "previous_stream_epoch",
///    "protocol",
///    "reason",
///    "sent_at",
///    "type"
///  ],
///  "properties": {
///    "desired_revision": {
///      "type": "integer",
///      "minimum": 0.0
///    },
///    "message_id": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "new_stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "previous_stream_epoch": {
///      "$ref": "#/definitions/Uuid"
///    },
///    "protocol": {
///      "const": 1
///    },
///    "reason": {
///      "enum": [
///        "history_truncated",
///        "restore",
///        "cursor_invalid",
///        "operator_reset"
///      ]
///    },
///    "sent_at": {
///      "$ref": "#/definitions/Timestamp"
///    },
///    "type": {
///      "const": "stream.reset"
///    }
///  },
///  "additionalProperties": true
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct StreamReset {
    pub desired_revision: u64,
    pub message_id: ::uuid::Uuid,
    pub new_stream_epoch: ::uuid::Uuid,
    pub previous_stream_epoch: ::uuid::Uuid,
    pub protocol: ::serde_json::Value,
    pub reason: StreamResetReason,
    pub sent_at: Timestamp,
    #[serde(rename = "type")]
    pub type_: ::serde_json::Value,
}
///`StreamResetReason`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "enum": [
///    "history_truncated",
///    "restore",
///    "cursor_invalid",
///    "operator_reset"
///  ]
///}
/// ```
/// </details>
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum StreamResetReason {
    #[serde(rename = "history_truncated")]
    HistoryTruncated,
    #[serde(rename = "restore")]
    Restore,
    #[serde(rename = "cursor_invalid")]
    CursorInvalid,
    #[serde(rename = "operator_reset")]
    OperatorReset,
}
impl ::std::fmt::Display for StreamResetReason {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::HistoryTruncated => f.write_str("history_truncated"),
            Self::Restore => f.write_str("restore"),
            Self::CursorInvalid => f.write_str("cursor_invalid"),
            Self::OperatorReset => f.write_str("operator_reset"),
        }
    }
}
impl ::std::str::FromStr for StreamResetReason {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "history_truncated" => Ok(Self::HistoryTruncated),
            "restore" => Ok(Self::Restore),
            "cursor_invalid" => Ok(Self::CursorInvalid),
            "operator_reset" => Ok(Self::OperatorReset),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for StreamResetReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for StreamResetReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for StreamResetReason {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`Timestamp`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "format": "date-time"
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct Timestamp(pub ::chrono::DateTime<::chrono::offset::Utc>);
impl ::std::ops::Deref for Timestamp {
    type Target = ::chrono::DateTime<::chrono::offset::Utc>;
    fn deref(&self) -> &::chrono::DateTime<::chrono::offset::Utc> {
        &self.0
    }
}
impl ::std::convert::From<Timestamp> for ::chrono::DateTime<::chrono::offset::Utc> {
    fn from(value: Timestamp) -> Self {
        value.0
    }
}
impl ::std::convert::From<::chrono::DateTime<::chrono::offset::Utc>> for Timestamp {
    fn from(value: ::chrono::DateTime<::chrono::offset::Utc>) -> Self {
        Self(value)
    }
}
impl ::std::str::FromStr for Timestamp {
    type Err = <::chrono::DateTime<::chrono::offset::Utc> as ::std::str::FromStr>::Err;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.parse()?))
    }
}
impl ::std::convert::TryFrom<&str> for Timestamp {
    type Error = <::chrono::DateTime<::chrono::offset::Utc> as ::std::str::FromStr>::Err;
    fn try_from(value: &str) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<String> for Timestamp {
    type Error = <::chrono::DateTime<::chrono::offset::Utc> as ::std::str::FromStr>::Err;
    fn try_from(value: String) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::fmt::Display for Timestamp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
