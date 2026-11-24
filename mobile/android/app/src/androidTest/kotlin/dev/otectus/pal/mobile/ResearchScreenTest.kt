package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Rule
import org.junit.Test

/** Runtime coverage for the canonical completed-report/finding/passage DTO rendered by Work › Research. */
class ResearchScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun completedReportOpensAndFindingReopensItsExactPassage() {
        val detail = Json.parseToJsonElement(
            """{
              "id":"10000000-0000-4000-8000-000000000001",
              "sessionId":"20000000-0000-4000-8000-000000000002",
              "state":"completed",
              "report":{"artifactId":"research-report","versionId":"v2","name":"Fixture report.md"},
              "revisions":[{"versionId":"v1","time":1,"summary":"Initial report"}],
              "findings":[{"text":"The treatment improved outcomes [E1.P1].","citations":["E1.P1"],"status":"Supported"}],
              "evidence":[{
                "id":"E1","title":"Controlled trial","kind":"web","status":"read","retrievedAt":"2026-11-22T00:00:00Z",
                "passages":[{"id":"E1.P1","location":"Results · page 4","text":"The trial enrolled 120 participants and reported a twelve percent improvement."}]
              }]
            }"""
        ).jsonObject
        val opens = AtomicInteger()

        compose.setContent {
            var report by remember { mutableStateOf<String?>(null) }
            var expanded by remember { mutableStateOf<JsonObject?>(null) }
            MaterialTheme {
                LazyColumn(Modifier.fillMaxSize()) {
                    researchResultItems(
                        detail = detail,
                        report = report,
                        expandedPassage = expanded,
                        working = setOf("planning", "searching", "reading", "synthesizing"),
                        onOpenReport = {
                            opens.incrementAndGet()
                            report = "# Completed fixture report\n\nThe completed report preserves passage citation [E1.P1]."
                        },
                        onPassage = { id -> expanded = id?.let { buildJsonObject {
                            put("id", it); put("location", "Results · page 4")
                            put("text", "The trial enrolled 120 participants and reported a twelve percent improvement.")
                        } } },
                        onExclude = {},
                    )
                }
            }
        }

        compose.onNodeWithText("Open report").assertIsDisplayed().performClick()
        compose.onNodeWithText("Completed fixture report", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("The treatment improved outcomes [E1.P1].").performScrollTo().performClick()
        compose.onNodeWithText("The trial enrolled 120 participants and reported a twelve percent improvement.")
            .performScrollTo().assertIsDisplayed()
        compose.runOnIdle { check(opens.get() == 1) }
    }

    @Test
    fun globalTaskSelectionOpensItsCrossConversationOwner() {
        val tasks = Json.parseToJsonElement(
            """[
              {"id":"10000000-0000-4000-8000-000000000011","sessionId":"20000000-0000-4000-8000-000000000012","title":"Current project investigation","provider":"ollama","model":"qwen3","state":"completed","progress":"Complete"},
              {"id":"10000000-0000-4000-8000-000000000021","sessionId":"20000000-0000-4000-8000-000000000022","title":"Other project investigation","provider":"anthropic","model":"claude-sonnet","state":"searching","progress":"Reading source 3 of 8"}
            ]"""
        ) as JsonArray
        val rows = tasks.map { it.jsonObject }
        val destination = AtomicReference<String?>()

        compose.setContent {
            var selected by remember { mutableStateOf<JsonObject?>(null) }
            MaterialTheme {
                LazyColumn(Modifier.fillMaxSize()) {
                    researchTaskItems(
                        runs = rows,
                        sessionTitle = { id -> if (id.endsWith("12")) "Conversation Alpha" else "Conversation Beta" },
                        onOpen = { id -> selected = rows.first { it["id"]?.jsonPrimitive?.content == id } },
                    )
                    selected?.let { task -> item {
                        ResearchConversationButton(task.getValue("sessionId").toString().trim('"')) { destination.set(it) }
                    } }
                }
            }
        }

        compose.onNodeWithText("Other project investigation").performClick()
        compose.onNodeWithText("Open conversation").performScrollTo().assertIsDisplayed().performClick()
        compose.runOnIdle { check(destination.get() == "20000000-0000-4000-8000-000000000022") }
    }
}
