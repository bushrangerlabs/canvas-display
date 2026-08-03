// GENERATED FILE — DO NOT EDIT.
// Source: contracts/scene/v1/scene-manifest.schema.json
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
///`AssetReference`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "AssetReference",
///  "type": "object",
///  "required": [
///    "hash",
///    "logical_path",
///    "media_type",
///    "size"
///  ],
///  "properties": {
///    "hash": {
///      "$ref": "#/definitions/SceneSha256Digest"
///    },
///    "logical_path": {
///      "type": "string",
///      "maxLength": 255,
///      "minLength": 1,
///      "pattern": "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?(?:/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?)*$"
///    },
///    "media_type": {
///      "type": "string",
///      "maxLength": 128,
///      "pattern": "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$"
///    },
///    "size": {
///      "type": "integer",
///      "maximum": 268435456.0,
///      "minimum": 1.0
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct AssetReference {
    pub hash: SceneSha256Digest,
    pub logical_path: AssetReferenceLogicalPath,
    pub media_type: AssetReferenceMediaType,
    pub size: ::std::num::NonZeroU64,
}
///`AssetReferenceLogicalPath`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 255,
///  "minLength": 1,
///  "pattern": "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?(?:/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?)*$"
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct AssetReferenceLogicalPath(::std::string::String);
impl ::std::ops::Deref for AssetReferenceLogicalPath {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<AssetReferenceLogicalPath> for ::std::string::String {
    fn from(value: AssetReferenceLogicalPath) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for AssetReferenceLogicalPath {
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
        static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
        {
            ::regress::Regex::new(
                    "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?(?:/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?)*$",
                )
                .unwrap()
        });
        if PATTERN.find(value).is_none() {
            return Err(
                "doesn't match pattern \"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?(?:/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?)*$\""
                    .into(),
            );
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for AssetReferenceLogicalPath {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for AssetReferenceLogicalPath {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for AssetReferenceLogicalPath {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for AssetReferenceLogicalPath {
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
///`AssetReferenceMediaType`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 128,
///  "pattern": "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$"
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct AssetReferenceMediaType(::std::string::String);
impl ::std::ops::Deref for AssetReferenceMediaType {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<AssetReferenceMediaType> for ::std::string::String {
    fn from(value: AssetReferenceMediaType) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for AssetReferenceMediaType {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 128usize {
            return Err("longer than 128 characters".into());
        }
        static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
        {
            ::regress::Regex::new(
                    "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$",
                )
                .unwrap()
        });
        if PATTERN.find(value).is_none() {
            return Err(
                "doesn't match pattern \"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$\""
                    .into(),
            );
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for AssetReferenceMediaType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for AssetReferenceMediaType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for AssetReferenceMediaType {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for AssetReferenceMediaType {
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
///`CanvasDescription`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "CanvasDescription",
///  "type": "object",
///  "required": [
///    "background",
///    "height",
///    "width"
///  ],
///  "properties": {
///    "background": {
///      "type": "string",
///      "maxLength": 128,
///      "minLength": 1
///    },
///    "height": {
///      "type": "integer",
///      "maximum": 16384.0,
///      "minimum": 1.0
///    },
///    "width": {
///      "type": "integer",
///      "maximum": 16384.0,
///      "minimum": 1.0
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct CanvasDescription {
    pub background: CanvasDescriptionBackground,
    pub height: ::std::num::NonZeroU64,
    pub width: ::std::num::NonZeroU64,
}
///`CanvasDescriptionBackground`
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
pub struct CanvasDescriptionBackground(::std::string::String);
impl ::std::ops::Deref for CanvasDescriptionBackground {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CanvasDescriptionBackground> for ::std::string::String {
    fn from(value: CanvasDescriptionBackground) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CanvasDescriptionBackground {
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
impl ::std::convert::TryFrom<&str> for CanvasDescriptionBackground {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for CanvasDescriptionBackground {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CanvasDescriptionBackground {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CanvasDescriptionBackground {
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
///`EntitySubscription`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "EntitySubscription",
///  "type": "object",
///  "required": [
///    "entity_id",
///    "fields"
///  ],
///  "properties": {
///    "entity_id": {
///      "type": "string",
///      "maxLength": 255,
///      "pattern": "^[a-z0-9_]+\\.[a-z0-9_]+$"
///    },
///    "fields": {
///      "type": "array",
///      "items": {
///        "type": "string",
///        "maxLength": 128,
///        "minLength": 1
///      },
///      "maxItems": 64,
///      "minItems": 1,
///      "uniqueItems": true
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct EntitySubscription {
    pub entity_id: EntitySubscriptionEntityId,
    pub fields: Vec<EntitySubscriptionFieldsItem>,
}
///`EntitySubscriptionEntityId`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "maxLength": 255,
///  "pattern": "^[a-z0-9_]+\\.[a-z0-9_]+$"
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct EntitySubscriptionEntityId(::std::string::String);
impl ::std::ops::Deref for EntitySubscriptionEntityId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EntitySubscriptionEntityId> for ::std::string::String {
    fn from(value: EntitySubscriptionEntityId) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EntitySubscriptionEntityId {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 255usize {
            return Err("longer than 255 characters".into());
        }
        static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
        { ::regress::Regex::new("^[a-z0-9_]+\\.[a-z0-9_]+$").unwrap() });
        if PATTERN.find(value).is_none() {
            return Err("doesn't match pattern \"^[a-z0-9_]+\\.[a-z0-9_]+$\"".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for EntitySubscriptionEntityId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EntitySubscriptionEntityId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EntitySubscriptionEntityId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EntitySubscriptionEntityId {
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
///`EntitySubscriptionFieldsItem`
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
pub struct EntitySubscriptionFieldsItem(::std::string::String);
impl ::std::ops::Deref for EntitySubscriptionFieldsItem {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<EntitySubscriptionFieldsItem> for ::std::string::String {
    fn from(value: EntitySubscriptionFieldsItem) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for EntitySubscriptionFieldsItem {
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
impl ::std::convert::TryFrom<&str> for EntitySubscriptionFieldsItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for EntitySubscriptionFieldsItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for EntitySubscriptionFieldsItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for EntitySubscriptionFieldsItem {
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
///`OfflinePolicy`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "OfflinePolicy",
///  "type": "object",
///  "required": [
///    "eligible",
///    "max_stale_seconds",
///    "schedule_eligible"
///  ],
///  "properties": {
///    "eligible": {
///      "type": "boolean"
///    },
///    "expires_at": {
///      "$ref": "#/definitions/SceneTimestamp"
///    },
///    "fallback_revision_id": {
///      "$ref": "#/definitions/SceneUuid"
///    },
///    "max_stale_seconds": {
///      "type": "integer",
///      "maximum": 31536000.0,
///      "minimum": 0.0
///    },
///    "schedule_eligible": {
///      "type": "boolean"
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct OfflinePolicy {
    pub eligible: bool,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub expires_at: ::std::option::Option<SceneTimestamp>,
    #[serde(default, skip_serializing_if = "::std::option::Option::is_none")]
    pub fallback_revision_id: ::std::option::Option<SceneUuid>,
    pub max_stale_seconds: i64,
    pub schedule_eligible: bool,
}
///`RendererRequirements`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "RendererRequirements",
///  "type": "object",
///  "required": [
///    "capabilities",
///    "minimum_version"
///  ],
///  "properties": {
///    "capabilities": {
///      "type": "array",
///      "items": {
///        "type": "string",
///        "maxLength": 128,
///        "minLength": 1
///      },
///      "maxItems": 128,
///      "uniqueItems": true
///    },
///    "minimum_version": {
///      "type": "string",
///      "maxLength": 64,
///      "minLength": 1
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RendererRequirements {
    pub capabilities: Vec<RendererRequirementsCapabilitiesItem>,
    pub minimum_version: RendererRequirementsMinimumVersion,
}
///`RendererRequirementsCapabilitiesItem`
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
pub struct RendererRequirementsCapabilitiesItem(::std::string::String);
impl ::std::ops::Deref for RendererRequirementsCapabilitiesItem {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<RendererRequirementsCapabilitiesItem>
for ::std::string::String {
    fn from(value: RendererRequirementsCapabilitiesItem) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for RendererRequirementsCapabilitiesItem {
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
impl ::std::convert::TryFrom<&str> for RendererRequirementsCapabilitiesItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for RendererRequirementsCapabilitiesItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for RendererRequirementsCapabilitiesItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for RendererRequirementsCapabilitiesItem {
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
///`RendererRequirementsMinimumVersion`
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
pub struct RendererRequirementsMinimumVersion(::std::string::String);
impl ::std::ops::Deref for RendererRequirementsMinimumVersion {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<RendererRequirementsMinimumVersion> for ::std::string::String {
    fn from(value: RendererRequirementsMinimumVersion) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for RendererRequirementsMinimumVersion {
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
impl ::std::convert::TryFrom<&str> for RendererRequirementsMinimumVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for RendererRequirementsMinimumVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for RendererRequirementsMinimumVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for RendererRequirementsMinimumVersion {
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
///`SceneDocumentReference`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SceneDocumentReference",
///  "type": "object",
///  "required": [
///    "hash",
///    "logical_path",
///    "media_type",
///    "size"
///  ],
///  "properties": {
///    "hash": {
///      "$ref": "#/definitions/SceneSha256Digest"
///    },
///    "logical_path": {
///      "const": "scene.json"
///    },
///    "media_type": {
///      "const": "application/vnd.canvas.scene+json"
///    },
///    "size": {
///      "type": "integer",
///      "maximum": 268435456.0,
///      "minimum": 1.0
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SceneDocumentReference {
    pub hash: SceneSha256Digest,
    pub logical_path: ::serde_json::Value,
    pub media_type: ::serde_json::Value,
    pub size: ::std::num::NonZeroU64,
}
///Immutable, credential-free Canvas scene revision manifest delivered by Core and staged by Edge.
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "$id": "https://schemas.canvas-display.local/scene/v1/scene-manifest.schema.json",
///  "title": "SceneManifestV1",
///  "description": "Immutable, credential-free Canvas scene revision manifest delivered by Core and staged by Edge.",
///  "type": "object",
///  "required": [
///    "assets",
///    "canvas",
///    "document",
///    "entity_subscriptions",
///    "manifest_digest",
///    "offline",
///    "published_at",
///    "requirements",
///    "revision_id",
///    "revision_number",
///    "scene_id",
///    "schema_version",
///    "security"
///  ],
///  "properties": {
///    "assets": {
///      "type": "array",
///      "items": {
///        "$ref": "#/definitions/AssetReference"
///      },
///      "maxItems": 2048,
///      "uniqueItems": true
///    },
///    "canvas": {
///      "$ref": "#/definitions/CanvasDescription"
///    },
///    "document": {
///      "$ref": "#/definitions/SceneDocumentReference"
///    },
///    "entity_subscriptions": {
///      "type": "array",
///      "items": {
///        "$ref": "#/definitions/EntitySubscription"
///      },
///      "maxItems": 2048,
///      "uniqueItems": true
///    },
///    "manifest_digest": {
///      "$ref": "#/definitions/SceneSha256Digest"
///    },
///    "offline": {
///      "$ref": "#/definitions/OfflinePolicy"
///    },
///    "published_at": {
///      "$ref": "#/definitions/SceneTimestamp"
///    },
///    "requirements": {
///      "$ref": "#/definitions/RendererRequirements"
///    },
///    "revision_id": {
///      "$ref": "#/definitions/SceneUuid"
///    },
///    "revision_number": {
///      "type": "integer",
///      "maximum": 9007199254740991.0,
///      "minimum": 1.0
///    },
///    "scene_id": {
///      "$ref": "#/definitions/SceneUuid"
///    },
///    "schema_version": {
///      "const": 1
///    },
///    "security": {
///      "$ref": "#/definitions/SceneSecurityPolicy"
///    }
///  },
///  "additionalProperties": false,
///  "$comment": "manifest_digest is sha256 over RFC 8785 JCS bytes after omitting only the top-level manifest_digest field."
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SceneManifestV1 {
    pub assets: Vec<AssetReference>,
    pub canvas: CanvasDescription,
    pub document: SceneDocumentReference,
    pub entity_subscriptions: Vec<EntitySubscription>,
    pub manifest_digest: SceneSha256Digest,
    pub offline: OfflinePolicy,
    pub published_at: SceneTimestamp,
    pub requirements: RendererRequirements,
    pub revision_id: SceneUuid,
    pub revision_number: ::std::num::NonZeroU64,
    pub scene_id: SceneUuid,
    pub schema_version: ::serde_json::Value,
    pub security: SceneSecurityPolicy,
}
///`SceneSecurityPolicy`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "title": "SceneSecurityPolicy",
///  "type": "object",
///  "required": [
///    "allow_iframes",
///    "allow_raw_html",
///    "allowed_origins"
///  ],
///  "properties": {
///    "allow_iframes": {
///      "type": "boolean"
///    },
///    "allow_raw_html": {
///      "type": "boolean"
///    },
///    "allowed_origins": {
///      "type": "array",
///      "items": {
///        "type": "string",
///        "format": "uri",
///        "maxLength": 512,
///        "pattern": "^https?://[^/@?#]+$"
///      },
///      "maxItems": 128,
///      "uniqueItems": true
///    }
///  },
///  "additionalProperties": false
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SceneSecurityPolicy {
    pub allow_iframes: bool,
    pub allow_raw_html: bool,
    pub allowed_origins: Vec<SceneSecurityPolicyAllowedOriginsItem>,
}
///`SceneSecurityPolicyAllowedOriginsItem`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "format": "uri",
///  "maxLength": 512,
///  "pattern": "^https?://[^/@?#]+$"
///}
/// ```
/// </details>
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct SceneSecurityPolicyAllowedOriginsItem(::std::string::String);
impl ::std::ops::Deref for SceneSecurityPolicyAllowedOriginsItem {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<SceneSecurityPolicyAllowedOriginsItem>
for ::std::string::String {
    fn from(value: SceneSecurityPolicyAllowedOriginsItem) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for SceneSecurityPolicyAllowedOriginsItem {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 512usize {
            return Err("longer than 512 characters".into());
        }
        static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
        { ::regress::Regex::new("^https?://[^/@?#]+$").unwrap() });
        if PATTERN.find(value).is_none() {
            return Err("doesn't match pattern \"^https?://[^/@?#]+$\"".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for SceneSecurityPolicyAllowedOriginsItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String>
for SceneSecurityPolicyAllowedOriginsItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String>
for SceneSecurityPolicyAllowedOriginsItem {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for SceneSecurityPolicyAllowedOriginsItem {
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
///`SceneSha256Digest`
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
pub struct SceneSha256Digest(::std::string::String);
impl ::std::ops::Deref for SceneSha256Digest {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<SceneSha256Digest> for ::std::string::String {
    fn from(value: SceneSha256Digest) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for SceneSha256Digest {
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
impl ::std::convert::TryFrom<&str> for SceneSha256Digest {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<&::std::string::String> for SceneSha256Digest {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for SceneSha256Digest {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for SceneSha256Digest {
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
///`SceneTimestamp`
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
pub struct SceneTimestamp(pub ::chrono::DateTime<::chrono::offset::Utc>);
impl ::std::ops::Deref for SceneTimestamp {
    type Target = ::chrono::DateTime<::chrono::offset::Utc>;
    fn deref(&self) -> &::chrono::DateTime<::chrono::offset::Utc> {
        &self.0
    }
}
impl ::std::convert::From<SceneTimestamp> for ::chrono::DateTime<::chrono::offset::Utc> {
    fn from(value: SceneTimestamp) -> Self {
        value.0
    }
}
impl ::std::convert::From<::chrono::DateTime<::chrono::offset::Utc>> for SceneTimestamp {
    fn from(value: ::chrono::DateTime<::chrono::offset::Utc>) -> Self {
        Self(value)
    }
}
impl ::std::str::FromStr for SceneTimestamp {
    type Err = <::chrono::DateTime<::chrono::offset::Utc> as ::std::str::FromStr>::Err;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.parse()?))
    }
}
impl ::std::convert::TryFrom<&str> for SceneTimestamp {
    type Error = <::chrono::DateTime<::chrono::offset::Utc> as ::std::str::FromStr>::Err;
    fn try_from(value: &str) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<String> for SceneTimestamp {
    type Error = <::chrono::DateTime<::chrono::offset::Utc> as ::std::str::FromStr>::Err;
    fn try_from(value: String) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::fmt::Display for SceneTimestamp {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
///`SceneUuid`
///
/// <details><summary>JSON schema</summary>
///
/// ```json
///{
///  "type": "string",
///  "format": "uuid"
///}
/// ```
/// </details>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct SceneUuid(pub ::uuid::Uuid);
impl ::std::ops::Deref for SceneUuid {
    type Target = ::uuid::Uuid;
    fn deref(&self) -> &::uuid::Uuid {
        &self.0
    }
}
impl ::std::convert::From<SceneUuid> for ::uuid::Uuid {
    fn from(value: SceneUuid) -> Self {
        value.0
    }
}
impl ::std::convert::From<::uuid::Uuid> for SceneUuid {
    fn from(value: ::uuid::Uuid) -> Self {
        Self(value)
    }
}
impl ::std::str::FromStr for SceneUuid {
    type Err = <::uuid::Uuid as ::std::str::FromStr>::Err;
    fn from_str(value: &str) -> ::std::result::Result<Self, Self::Err> {
        Ok(Self(value.parse()?))
    }
}
impl ::std::convert::TryFrom<&str> for SceneUuid {
    type Error = <::uuid::Uuid as ::std::str::FromStr>::Err;
    fn try_from(value: &str) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<String> for SceneUuid {
    type Error = <::uuid::Uuid as ::std::str::FromStr>::Err;
    fn try_from(value: String) -> ::std::result::Result<Self, Self::Error> {
        value.parse()
    }
}
impl ::std::fmt::Display for SceneUuid {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        self.0.fmt(f)
    }
}
