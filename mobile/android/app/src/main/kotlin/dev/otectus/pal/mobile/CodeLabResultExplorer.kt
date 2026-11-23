@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.PALRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

/** All displayed record numbers and selections refer to an immutable output version. */
@Composable
internal fun CodeLabResultExplorer(repository: PALRepository, activity: FragmentActivity, sessionId: String, outputs: List<JsonObject>, operationId: String? = null) {
    val scope = rememberCoroutineScope()
    val ids = outputs.mapNotNull { it.str("versionId") }
    val metadata = remember(sessionId, ids) { mutableStateMapOf<String, JsonObject>() }
    var version by rememberSaveable(sessionId, ids.firstOrNull()) { mutableStateOf(ids.firstOrNull().orEmpty()) }
    val ref = outputs.find { it.str("versionId") == version } ?: return
    val artifactId = ref.str("artifactId") ?: return
    val item = metadata[version]
    val name = item?.str("name").orEmpty()
    val isTable = name.endsWith(".csv",true) || name.endsWith(".tsv",true)
    var filter by remember(version) { mutableStateOf("") }
    var sort by remember(version) { mutableStateOf("") }
    var descending by remember(version) { mutableStateOf(false) }
    var offset by remember(version) { mutableIntStateOf(0) }
    var selected by remember(version) { mutableStateOf<Set<Int>>(emptySet()) }
    var table by remember(version) { mutableStateOf<JsonObject?>(null) }
    var image by remember(version) { mutableStateOf<Bitmap?>(null) }
    var error by remember(version) { mutableStateOf("") }
    var feedback by remember(version) { mutableStateOf("") }
    val exportTitle = stringResource(R.string.lab_rows_export)
    val explainTitle = stringResource(R.string.lab_explain_record)
    fun args() = buildJsonObject {
        put("sessionId",sessionId); put("artifactId",artifactId); put("versionId",version)
        put("query",filter); if (sort.isNotEmpty()) put("sort",sort); put("direction",if (descending) "desc" else "asc")
    }
    LaunchedEffect(sessionId, ids) {
        for (output in outputs) {
            val id = output.str("versionId") ?: continue
            try {
                val result = repository.read("workbench.artifacts.get", buildJsonObject {
                    put("sessionId",sessionId); put("artifactId",output.str("artifactId"))
                }).jsonObject
                result.list("versions").firstOrNull { it.str("versionId") == id }?.let { metadata[id]=it }
            } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error=failure.message.orEmpty() }
        }
    }
    LaunchedEffect(sessionId, version, name, filter, sort, descending, offset) {
        table=null; selected=emptySet()
        if (item == null) return@LaunchedEffect
        try {
            if (isTable) {
                if (filter.isNotEmpty()) kotlinx.coroutines.delay(220)
                table=repository.read("workbench.codelab.table",JsonObject(args() + mapOf("offset" to JsonPrimitive(offset),"limit" to JsonPrimitive(50)))).jsonObject
            } else if (item.str("kind") in setOf("image","plot")) {
                val data=repository.read("workbench.artifacts.thumbnail",buildJsonObject {
                    put("sessionId",sessionId); put("artifactId",artifactId); put("versionId",version); put("size",1024)
                }).jsonObject.str("data")
                image=data?.let { withContext(Dispatchers.Default) {
                    val bytes=Base64.decode(it.substringAfter("base64,"),Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes,0,bytes.size)
                } }
            }
            error=""
        } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error=failure.message.orEmpty() }
    }
    Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.lab_results),style=MaterialTheme.typography.titleSmall)
        FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)) {
            outputs.forEach { output ->
                val id=output.str("versionId").orEmpty()
                FilterChip(version==id,{ version=id },{Text(metadata[id]?.str("name") ?: id.take(8))})
            }
        }
        image?.let { Image(it.asImageBitmap(),name,Modifier.fillMaxWidth().heightIn(max=360.dp)) }
        if (isTable) {
            OutlinedTextField(filter,{filter=it;offset=0},Modifier.fillMaxWidth(),label={Text(stringResource(R.string.lab_filter))},singleLine=true)
            table?.let { data ->
                val columns=(data["columns"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }
                FlowRow { columns.forEach { column ->
                    FilterChip(sort==column,{ if(sort==column) descending=!descending else {sort=column;descending=false}; offset=0 },
                        {Text(column + if (sort != column) "" else if (descending) " ↓" else " ↑")})
                } }
                LazyColumn(Modifier.heightIn(max=360.dp)) {
                    items(data.list("rows"),key={it.int("row") ?: 0}) { row ->
                        val number=row.int("row") ?: 0
                        val values=(row["values"] as? JsonArray).orEmpty().joinToString(" | ") { it.jsonPrimitive.content }
                        Row(Modifier.fillMaxWidth()) {
                            Checkbox(number in selected,{ selected=if(number in selected) selected-number else selected+number })
                            Text("#$number · $values",style=MaterialTheme.typography.bodySmall.copy(fontFamily=FontFamily.Monospace))
                        }
                    }
                }
                FlowRow {
                    TextButton({offset-=50},enabled=offset>=50){Text(stringResource(R.string.lab_previous))}
                    TextButton({offset+=50},enabled=offset+50<(data.int("matched") ?: 0)){Text(stringResource(R.string.lab_next))}
                    TextButton({scope.launch {
                        val payload=if(selected.isEmpty()) args() else JsonObject(args()+("rows" to JsonArray(selected.map(::JsonPrimitive))))
                        try {
                            val exported=signed(activity,repository,"workbench.codelab.exportRows",payload,exportTitle).jsonObject
                            feedback=activity.getString(R.string.lab_exported,exported.str("versionId").orEmpty().take(8))
                        } catch (cancelled: CancellationException) {throw cancelled} catch (failure: Exception) {error=failure.message.orEmpty()}
                    }}){Text(exportTitle)}
                    if (selected.size==1 && operationId!=null) TextButton({scope.launch {
                        try {
                            val draft=repository.read("workbench.codelab.open",buildJsonObject {put("sessionId",sessionId);put("operationId",operationId)}).jsonObject
                            val result=signed(activity,repository,"workbench.codelab.assist",buildJsonObject {
                                put("sessionId",sessionId);put("operationId",operationId);put("mode","explain");put("request",explainTitle)
                                put("code",draft.str("code").orEmpty());put("language",draft.str("language") ?: "python");put("inputs",draft["inputs"] ?: JsonArray(emptyList()))
                                put("result",buildJsonObject {put("artifactId",artifactId);put("versionId",version);put("row",selected.single());if(sort.isNotBlank())put("column",sort)})
                            },explainTitle).jsonObject
                            feedback=result.str("explanation").orEmpty()
                        } catch (cancelled: CancellationException) {throw cancelled} catch (failure: Exception) {error=failure.message.orEmpty()}
                    }}){Text(explainTitle)}
                }
                (data["problems"] as? JsonArray)?.forEach {Text(it.jsonPrimitive.content,color=MaterialTheme.colorScheme.error)}
            }
        }
        if(feedback.isNotBlank())Text(feedback)
        if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)
    }
}
