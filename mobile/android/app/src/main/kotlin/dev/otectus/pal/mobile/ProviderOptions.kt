package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import dev.otectus.pal.mobile.data.ProviderOptionField
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/** Typed provider controls shared by creation and conversation settings; secrets never belong here. */
@Composable
internal fun ProviderOptions(
    fields: List<ProviderOptionField>,
    values: JsonObject,
    variant: String? = null,
    enabled: Boolean = true,
    /** Options the screen already shows another way. */
    hidden: Set<String> = emptySet(),
    onChange: (JsonObject) -> Unit,
) {
    val shown = fields.filter { (it.key !in hidden || it.key in values) && (it.operations.isEmpty() || "chat" in it.operations) && (it.variants.isEmpty() || variant in it.variants) }
    if (shown.isEmpty()) return
    AncillarySection("Provider options", "Only options supported by this provider and connection are shown.") {
        shown.forEach { field ->
            val current = values[field.key] ?: field.default
            fun update(value: JsonElement?) = onChange(JsonObject(values.toMutableMap().apply {
                if (value == null || value is JsonNull) remove(field.key) else put(field.key, value)
            }))
            when (field.type) {
                "boolean" -> androidx.compose.material3.ListItem(
                    headlineContent = { Text(field.label) },
                    supportingContent = field.description?.let { description -> ({ Text(description) }) },
                    trailingContent = { Switch(current?.let { (it as? JsonPrimitive)?.booleanOrNull } == true, { update(JsonPrimitive(it)) }, enabled = enabled) },
                )
                "enum" -> Column(Modifier.fillMaxWidth()) {
                    Text(field.label)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                        field.choices.forEach { choice -> FilterChip(
                            selected = current?.let { (it as? JsonPrimitive)?.contentOrNull } == choice.id,
                            // Tapping the chosen one again returns to the provider’s own choice.
                            onClick = { update(if ((values[field.key] as? JsonPrimitive)?.contentOrNull == choice.id) null else JsonPrimitive(choice.id)) },
                            label = { Text(choice.label) },
                            enabled = enabled,
                        ) }
                    }
                    field.description?.let { Text(it, style = androidx.compose.material3.MaterialTheme.typography.bodySmall) }
                }
                else -> {
                    // What is typed is kept as typed: a list’s comma or a number’s point is not yet a value of its own.
                    var raw by rememberSaveable(field.key, fields) { mutableStateOf(optionText(current)) }
                    // Another control of the screen may have changed it: preferring who serves a model, for one.
                    val own = values[field.key]
                    LaunchedEffect(own) { if (optionValue(field, raw) != own && (own != null || optionValue(field, raw) != current)) raw = optionText(current) }
                    OutlinedTextField(
                        value = raw,
                        onValueChange = { typed -> raw = typed; update(optionValue(field, typed)) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(field.label) },
                        supportingText = field.description?.let { description -> ({ Text(description) }) },
                        enabled = enabled,
                        singleLine = field.type != "string-list",
                        isError = field.type == "number" && raw.isNotBlank() && optionValue(field, raw) == null,
                        keyboardOptions = KeyboardOptions(keyboardType = if (field.type == "number") KeyboardType.Decimal else KeyboardType.Text),
                    )
                }
            }
        }
    }
}

/** An option as the text field shows it. A whole number is shown without a fraction. */
internal fun optionText(value: JsonElement?): String = when (value) {
    is JsonArray -> value.joinToString(", ") { (it as? JsonPrimitive)?.contentOrNull.orEmpty() }
    is JsonPrimitive -> value.longOrNull?.toString() ?: value.contentOrNull.orEmpty()
    else -> ""
}
/** What the typed text means for this option, or nothing while it means nothing yet. */
internal fun optionValue(field: ProviderOptionField, typed: String): JsonElement? = when (field.type) {
    "number" -> typed.trim().toLongOrNull()?.let(::JsonPrimitive) ?: typed.trim().toDoubleOrNull()?.takeIf { it.isFinite() && !field.integer }?.let(::JsonPrimitive)
    "string-list" -> typed.split(',').map(String::trim).filter(String::isNotEmpty).takeIf { it.isNotEmpty() }?.let { JsonArray(it.map(::JsonPrimitive)) }
    else -> typed.takeIf(String::isNotBlank)?.let(::JsonPrimitive)
}
