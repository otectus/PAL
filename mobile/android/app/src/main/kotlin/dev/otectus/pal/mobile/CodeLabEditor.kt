@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*

private fun cell(name: String, code: String, language: String) = buildJsonObject {
    put("name", name)
    put("code", code)
    put("language", language)
}

/** Each visible cell is the same ordered definition the broker executes. */
@Composable
internal fun CodeLabEditor(
    code: String, setCode: (String) -> Unit, language: String, setLanguage: (String) -> Unit,
    purpose: String, setPurpose: (String) -> Unit, parameters: String, setParameters: (String) -> Unit,
    steps: List<JsonObject>, setSteps: (List<JsonObject>) -> Unit, enabled: Boolean, run: () -> Unit
) {
    var index by rememberSaveable { mutableIntStateOf(0) }
    val selected = index.coerceIn(0, (steps.size - 1).coerceAtLeast(0))
    val current = steps.getOrNull(selected)
    val body = current?.str("code") ?: code
    val lang = current?.str("language") ?: language
    val name = current?.str("name") ?: stringResource(R.string.lab_first_step)
    fun change(list: List<JsonObject>) {
        setSteps(list)
        list.firstOrNull()?.let {
            setCode(it.str("code").orEmpty())
            setLanguage(it.str("language") ?: "python")
        }
    }
    fun edit(text: String = body, kind: String = lang, label: String = name) {
        if (current == null) {
            setCode(text)
            setLanguage(kind)
        } else change(steps.toMutableList().also { it[selected] = cell(label, text, kind) })
    }
    fun move(distance: Int) {
        val to = selected + distance
        change(steps.toMutableList().apply { add(to, removeAt(selected)) })
        index = to
    }
    Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        OutlinedTextField(purpose, setPurpose, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.lab_analysis_name)) })
        if (steps.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                steps.forEachIndexed { i, step ->
                    FilterChip(i == selected, { index = i }, { Text("${i + 1}. ${step.str("name").orEmpty()}") })
                }
            }
            OutlinedTextField(name, { edit(label = it) }, label = { Text(stringResource(R.string.lab_step_name)) })
        }
        Row {
            FilterChip(lang == "python", { edit(kind = "python") }, { Text(stringResource(R.string.work_python)) })
            FilterChip(lang == "sql", { edit(kind = "sql") }, { Text(stringResource(R.string.work_sql)) })
        }
        OutlinedTextField(body, { edit(text = it) }, Modifier.fillMaxWidth().heightIn(min = 140.dp),
            label = { Text(stringResource(R.string.lab_step_code)) }, textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace))
        FlowRow {
            TextButton({
                val list = steps.ifEmpty { listOf(cell(name, body, lang)) }
                change(list + cell("Step ${list.size + 1}", "", "python"))
                index = list.size
            }, enabled = steps.size < 12) { Text(stringResource(R.string.lab_add_step)) }
            if (steps.isNotEmpty()) {
                TextButton({ move(-1) }, enabled = selected > 0) { Text(stringResource(R.string.lab_up)) }
                TextButton({ move(1) }, enabled = selected < steps.lastIndex) { Text(stringResource(R.string.lab_down)) }
                TextButton({
                    change(steps.filterIndexed { i, _ -> i != selected })
                    if (steps.size == 1) setCode("")
                    index = (selected - 1).coerceAtLeast(0)
                }) { Text(stringResource(R.string.lab_remove_step)) }
            }
        }
        OutlinedTextField(parameters, setParameters, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.work_parameters_json)) })
        Button(run, enabled = enabled && (steps.isEmpty() && code.isNotBlank() || steps.isNotEmpty() && steps.all { !it.str("code").isNullOrBlank() && !it.str("name").isNullOrBlank() })) {
            Text(stringResource(R.string.lab_run))
        }
    }
}
