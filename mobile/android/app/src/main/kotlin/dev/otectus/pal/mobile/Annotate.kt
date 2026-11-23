package dev.otectus.pal.mobile

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.Path
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.Role
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
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
    val strings = androidx.compose.ui.platform.LocalResources.current

    var marks by remember { mutableStateOf(listOf<Mark>()) }
    var current by remember { mutableStateOf<Mark?>(null) }
    var color by remember { mutableStateOf(PALMedia.annotationPrimary) }
    var thick by remember { mutableStateOf(false) }
    var frame by remember { mutableStateOf(Pair(Offset.Zero, Size.Zero)) }
    val image = remember(preview) { preview.asImageBitmap() }
    fun inImage(point: Offset): Offset { val (origin, size) = frame; return Offset(((point.x - origin.x) / size.width).coerceIn(0f, 1f), ((point.y - origin.y) / size.height).coerceIn(0f, 1f)) }
    Dialog(onCancel, DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().padding(PALLayout.small)) {
                Text(stringResource(R.string.annotation_draw_on_the_image), style = MaterialTheme.typography.titleMedium)
                Canvas(Modifier.weight(1f).fillMaxWidth().semantics { contentDescription = strings.getString(R.string.annotation_image_to_draw_on) }.pointerInput(Unit) {
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
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PALLayout.tight),
                    itemVerticalAlignment = Alignment.CenterVertically) {
                    listOf(PALMedia.annotationPrimary to R.string.mark_red, PALMedia.annotationHighlight to R.string.mark_yellow,
                        PALMedia.onBackdrop to R.string.mark_white, PALMedia.backdrop to R.string.mark_black).forEach { (choice, label) ->
                        val name = stringResource(label)
                        Box(Modifier.size(PALLayout.target).selectable(color == choice, role = Role.RadioButton) { color = choice }
                            .semantics { contentDescription = name }, contentAlignment = Alignment.Center) {
                            Box(Modifier.size(PALLayout.spacious).background(choice, CircleShape)
                                .border(PALLayout.hairline, MaterialTheme.colorScheme.outline, CircleShape), contentAlignment = Alignment.Center) {
                                if (color == choice) Icon(Icons.Default.Check, null, Modifier.size(PALLayout.iconSmall),
                                    tint = if (choice == PALMedia.backdrop) PALMedia.onBackdrop else PALMedia.backdrop)
                            }
                        }
                    }
                    FilterChip(thick, { thick = !thick }, { Text(stringResource(R.string.annotation_thick)) })
                    TextButton({ marks = marks.dropLast(1) }, enabled = marks.isNotEmpty()) { Text(stringResource(R.string.annotation_undo)) }
                }
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PALLayout.small, Alignment.End)) {
                    TextButton(onCancel) { Text(stringResource(R.string.annotation_cancel)) }
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
                    }, enabled = marks.isNotEmpty()) { Text(stringResource(R.string.annotation_save_as_a_new_version)) }
                }
            }
        }
    }
}
