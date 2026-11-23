package dev.otectus.pal.mobile

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import org.commonmark.ext.gfm.tables.*
import org.commonmark.node.*
import org.commonmark.node.Text as TextNode
import org.commonmark.parser.Parser
import java.net.URI
import java.util.Locale

private val markdownParser = Parser.builder().extensions(listOf(TablesExtension.create())).build()
private fun Node.nodes(): List<Node> = buildList { var node = firstChild; while (node != null) { add(node); node = node.next } }

/** Native selectable Markdown. Links open only on tap; image URLs are never fetched here. */
@Composable
fun PALMarkdown(value: String) {
    // A large response can arrive in successive revisions. Parse those away from the input
    // thread, retaining the visible prefix while the next revision is being formatted.
    val retained = remember { mutableStateOf<Pair<String, Node>?>(null) }
    val document = if (value.length <= 4096) {
        val immediate = remember(value) { markdownParser.parse(value) }
        SideEffect { if (retained.value?.first != value) retained.value = value to immediate }
        immediate
    } else {
        LaunchedEffect(value) {
            val source = value
            retained.value = withContext(Dispatchers.Default) { source to markdownParser.parse(source) }
        }
        // Streaming normally appends to the current response. Keep that fully rendered prefix
        // visible while parsing the next revision instead of flashing a progress-only row.
        retained.value?.takeIf { value.startsWith(it.first) }?.second
    }
    if (document == null) {
        LinearProgressIndicator(Modifier.fillMaxWidth())
        return
    }
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceContainerHighest
    val resources = LocalResources.current
    SelectionContainer {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            document.nodes().forEach { MarkdownBlock(it, 0, linkColor, codeBackground, resources) }
        }
    }
}

@Composable
private fun MarkdownBlock(node: Node, depth: Int, linkColor: Color, codeBackground: Color, resources: android.content.res.Resources) {
    if (depth > 24) { Text(node.inlineText(linkColor, codeBackground, resources)); return }
    when (node) {
        is Heading -> Text(node.inlineText(linkColor, codeBackground, resources), modifier = Modifier.semantics { heading() },
            style = when (node.level) { 1 -> MaterialTheme.typography.headlineSmall; 2 -> MaterialTheme.typography.titleLarge; else -> MaterialTheme.typography.titleMedium },
            fontWeight = FontWeight.Bold)
        is FencedCodeBlock -> CodeBlock(node.literal, node.info)
        is IndentedCodeBlock -> CodeBlock(node.literal, "")
        is BlockQuote -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(Modifier.width(PALLayout.focusStroke).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
            Column(Modifier.padding(start = PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                node.nodes().forEach { MarkdownBlock(it, depth + 1, linkColor, codeBackground, resources) }
            }
        }
        is BulletList, is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            node.nodes().forEachIndexed { index, item -> Row {
                Text(if (node is OrderedList) "${node.markerStartNumber + index}${node.markerDelimiter} " else "• ",
                    Modifier.widthIn(min = PALLayout.spacious), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    item.nodes().forEach { MarkdownBlock(it, depth + 1, linkColor, codeBackground, resources) }
                }
            } }
        }
        is TableBlock -> MarkdownTable(node, linkColor, codeBackground, resources)
        is ThematicBreak -> HorizontalDivider(Modifier.padding(vertical = PALLayout.tight))
        is HtmlBlock -> CodeBlock(node.literal, "HTML")
        is org.commonmark.node.Paragraph -> Text(node.inlineText(linkColor, codeBackground, resources), style = MaterialTheme.typography.bodyLarge)
        else -> if (node.firstChild != null) node.nodes().forEach {
            MarkdownBlock(it, depth + 1, linkColor, codeBackground, resources)
        } else Text(node.inlineText(linkColor, codeBackground, resources))
    }
}

@Composable
private fun CodeBlock(source: String, language: String) {
    val context = LocalContext.current
    var copied by remember(source) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(2_000)
            copied = false
        }
    }
    val languageLabel = language.trim().take(48).ifBlank { stringResource(R.string.markdown_code) }
    val description = stringResource(R.string.markdown_code_description, languageLabel)
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium,
        border = BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = description }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = PALLayout.gutter, vertical = PALLayout.small)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(languageLabel, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton({
                    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(languageLabel, source))
                    copied = true
                }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(stringResource(if (copied) R.string.markdown_code_copied else R.string.markdown_copy_code))
                }
            }
            Text(source.trimEnd('\n'), Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 4.dp),
                fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, softWrap = false)
        }
    }
}

internal fun markdownTableColumnWidth(maxCharacters: Int): Int = (maxCharacters.coerceAtLeast(1) * 8 + 32).coerceIn(120, 280)

@Composable
private fun MarkdownTable(table: TableBlock, linkColor: Color, codeBackground: Color, resources: android.content.res.Resources) {
    val rows = table.nodes().flatMap { section -> section.nodes().map { it to (section is TableHead) } }
    val columns = rows.maxOfOrNull { (row) -> row.nodes().size } ?: 0
    val widths = (0 until columns).map { column ->
        markdownTableColumnWidth(rows.maxOfOrNull { (row) -> row.nodes().getOrNull(column)?.plainText()?.length ?: 0 } ?: 0).dp
    }
    val tableDescription = stringResource(R.string.markdown_table_description, rows.size, columns)
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium,
        border = BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = tableDescription }) {
        Column(Modifier.horizontalScroll(rememberScrollState())) { rows.forEachIndexed { index, (row, header) ->
            Row(Modifier.background(if (header) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)) {
                row.nodes().forEachIndexed { column, cell ->
                Text(cell.inlineText(linkColor, codeBackground, resources), Modifier.width(widths.getOrElse(column) { 120.dp }).padding(PALLayout.small),
                    style = MaterialTheme.typography.bodyMedium, fontWeight = if (header) FontWeight.Bold else FontWeight.Normal,
                    textAlign = when ((cell as? TableCell)?.alignment) {
                        TableCell.Alignment.CENTER -> TextAlign.Center
                        TableCell.Alignment.RIGHT -> TextAlign.End
                        else -> TextAlign.Start
                    })
            } }
            if (index != rows.lastIndex) HorizontalDivider()
        } }
    }
}

private fun Node.plainText(): String = buildString {
    fun appendNode(node: Node) {
        when (node) {
            is TextNode -> append(node.literal)
            is Code -> append(node.literal)
            is SoftLineBreak, is HardLineBreak -> append(' ')
            else -> node.nodes().forEach(::appendNode)
        }
    }
    appendNode(this@plainText)
}

/** An address the app may open on tap: http(s) with a host and no embedded credentials. */
internal fun safeLink(value: String): String? {
    if (value.isBlank() || value.any { it.isISOControl() }) return null
    return runCatching { URI(value) }.getOrNull()?.takeIf {
        it.scheme?.lowercase(Locale.ROOT) in setOf("https", "http") && !it.host.isNullOrBlank() && it.userInfo == null
    }?.toASCIIString()
}

private fun Node.inlineText(linkColor: Color, codeBackground: Color, resources: android.content.res.Resources): AnnotatedString =
    buildAnnotatedString { appendInline(this@inlineText, 0, linkColor, codeBackground, resources) }

private fun AnnotatedString.Builder.appendInline(
    node: Node,
    depth: Int,
    linkColor: Color,
    codeBackground: Color,
    resources: android.content.res.Resources,
) {
    if (depth > 64) return
    fun children() { node.nodes().forEach { appendInline(it, depth + 1, linkColor, codeBackground, resources) } }
    fun linkStyles() = TextLinkStyles(style = SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))
    when (node) {
        is TextNode -> append(node.literal)
        is SoftLineBreak -> append("\n")
        is HardLineBreak -> append("\n")
        is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(node.literal) }
        is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { children() }
        is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { children() }
        is Link -> safeLink(node.destination)?.let { url -> withLink(LinkAnnotation.Url(url, linkStyles())) { children() } } ?: children()
        is Image -> {
            val alt = buildAnnotatedString { node.nodes().forEach {
                appendInline(it, depth + 1, linkColor, codeBackground, resources)
            } }.text.trim()
            append(if (alt.isBlank()) resources.getString(R.string.markdown_image_without_description)
                else resources.getString(R.string.markdown_image, alt))
            safeLink(node.destination)?.let { url ->
                append(" · ")
                withLink(LinkAnnotation.Url(url, linkStyles())) { append(resources.getString(R.string.markdown_open_image)) }
            }
        }
        // Raw HTML is neither executed nor exposed as visual markup. Its text children remain.
        is HtmlInline -> Unit
        else -> children()
    }
}
