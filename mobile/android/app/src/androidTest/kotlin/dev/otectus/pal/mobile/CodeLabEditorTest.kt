package dev.otectus.pal.mobile

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import kotlinx.serialization.json.*
import org.junit.Rule
import org.junit.Test

class CodeLabEditorTest {
  @get:Rule val compose = createComposeRule()
  @Test fun editedOrderedCellsAreRetainedForRun() {
    var submitted = emptyList<JsonObject>()
    compose.setContent {
      var code by remember { mutableStateOf("first") }; var language by remember { mutableStateOf("python") }
      var purpose by remember { mutableStateOf("fixture") }; var parameters by remember { mutableStateOf("{}") }
      var steps by remember { mutableStateOf(listOf(buildJsonObject { put("name","one");put("code","first");put("language","python") }, buildJsonObject { put("name","two");put("code","second");put("language","sql") })) }
      MaterialTheme { CodeLabEditor(code,{code=it},language,{language=it},purpose,{purpose=it},parameters,{parameters=it},steps,{steps=it},true) { submitted=steps } }
    }
    compose.onAllNodesWithText("Down")[0].performClick()
    compose.onNodeWithText("Run Code Lab").performClick()
    compose.runOnIdle { check(submitted.map { it.str("name") } == listOf("two","one")) }
  }
}
