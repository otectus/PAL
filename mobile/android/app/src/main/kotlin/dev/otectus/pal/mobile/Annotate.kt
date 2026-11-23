package dev.otectus.pal.mobile

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.Path
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.io.ByteArrayOutputStream

/** A stroke in image coordinates (0–1 on each axis), so it renders at the original's full size. */
private data class Mark(val color: Color, val width: Float, val points: List<Offset>)

/**
 * Drawing on an image from the phone (PAL Everywhere §15.1): strokes over the preview, saved by the desktop as a new
 * version of the same artifact (the original version stays). The layer is rendered at the original's exact pixel
 * size, transparent except for the marks, which is what the desktop's flattening checks.
 */
@Composable
internal fun AnnotateImage(preview: Bitmap, width: Int, height: Int, onCancel: () -> Unit, onSave: (ByteArray) -> Unit) {
    var marks by remember { mutableStateOf(listOf<Mark>()) }
    var current by remember { mutableStateOf<Mark?>(null) }
    var color by remember { mutableStateOf(Color(0xFFE53935)) }
    var thick by remember { mutableStateOf(false) }
    var frame by remember { mutableStateOf(Pair(Offset.Zero, Size.Zero)) }
    val image = remember(preview) { preview.asImageBitmap() }
    fun inImage(point: Offset): Offset { val (origin, size) = frame; return Offset(((point.x - origin.x) / size.width).coerceIn(0f, 1f), ((point.y - origin.y) / size.height).coerceIn(0f, 1f)) }
    Dialog(onCancel, DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().padding(8.dp)) {
                Text("Draw on the image", style = MaterialTheme.typography.titleMedium)
                Canvas(Modifier.weight(1f).fillMaxWidth().semantics { contentDescription = "Image to draw on" }.pointerInput(Unit) {
                    detectDragGestures(onDragStart = { start -> current = Mark(color, if (thick) 0.012f else 0.005f, listOf(inImage(start))) },
                        onDragEnd = { current?.let { marks = marks + it }; current = null }, onDragCancel = { current = null },
                        onDrag = { change, _ -> current = current?.let { it.copy(points = it.points + inImage(change.position)) } })
                }) {
                    val scale = minOf(size.width / image.width, size.height / image.height)
                    val shown = Size(image.width * scale, image.height * scale)
                    val origin = Offset((size.width - shown.width) / 2, (size.height - shown.height) / 2)
                    frame = origin to shown
                    drawImage(image, dstOffset = IntOffset(origin.x.toInt(), origin.y.toInt()), dstSize = IntSize(shown.width.toInt(), shown.height.toInt()))
                    for (mark in marks + listOfNotNull(current)) {
                        val path = androidx.compose.ui.graphics.Path()
                        mark.points.forEachIndexed { index, point -> val x = origin.x + point.x * shown.width; val y = origin.y + point.y * shown.height; if (index == 0) path.moveTo(x, y) else path.lineTo(x, y) }
                        drawPath(path, mark.color, style = Stroke(width = mark.width * shown.width, cap = StrokeCap.Round))
                    }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(Color(0xFFE53935) to "Red", Color(0xFFFDD835) to "Yellow", Color.White to "White", Color.Black to "Black").forEach { (choice, name) ->
                        Box(Modifier.size(32.dp).background(choice, CircleShape).semantics { contentDescription = name }.pointerInput(choice) { detectDragGestures { _, _ -> } }) {
                            RadioButton(color == choice, { color = choice }, Modifier.align(Alignment.Center))
                        }
                    }
                    FilterChip(thick, { thick = !thick }, { Text("Thick") })
                    TextButton({ marks = marks.dropLast(1) }, enabled = marks.isNotEmpty()) { Text("Undo") }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    TextButton(onCancel) { Text("Cancel") }
                    Button({
                        // The layer at the original's size: transparent, with the strokes scaled from image coordinates.
                        val layer = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                        val canvas = android.graphics.Canvas(layer)
                        for (mark in marks) {
                            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; this.color = mark.color.toArgb(); strokeWidth = mark.width * width }
                            val path = Path(); mark.points.forEachIndexed { index, point -> if (index == 0) path.moveTo(point.x * width, point.y * height) else path.lineTo(point.x * width, point.y * height) }
                            canvas.drawPath(path, paint)
                        }
                        val out = ByteArrayOutputStream(); layer.compress(Bitmap.CompressFormat.PNG, 100, out); layer.recycle()
                        onSave(out.toByteArray())
                    }, enabled = marks.isNotEmpty()) { Text("Save as a new version") }
                }
            }
        }
    }
}
