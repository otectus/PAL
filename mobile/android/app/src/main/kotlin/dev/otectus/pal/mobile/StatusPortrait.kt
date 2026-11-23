package dev.otectus.pal.mobile

import android.content.Context
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.produceState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.Dp
import dev.otectus.pal.mobile.data.PortraitSheet
import dev.otectus.pal.mobile.protocol.PortraitState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** On-phone presentation choices (F95). They change only this phone, never the desktop. */
internal object UiPreferences {
    private const val FILE = "cere-ui"
    fun sendFromKeyboard(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean("sendFromKeyboard", false)
    fun setSendFromKeyboard(context: Context, enabled: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean("sendFromKeyboard", enabled).apply()
    }

    private var portrait: MutableStateFlow<Boolean>? = null
    fun portrait(context: Context): StateFlow<Boolean> = portrait ?: MutableStateFlow(context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean("portrait", true)).also { portrait = it }
    fun setPortrait(context: Context, shown: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean("portrait", shown).apply()
        (portrait ?: MutableStateFlow(shown).also { portrait = it }).value = shown
    }
}

private fun color(hex: String?, fallback: Color) = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(fallback)

/**
 * W11 (F93): the desktop's portrait as a still status avatar: the expression the desktop would show for
 * this state, in its colors. It never animates; the state is also written beside it as text.
 */
@Composable
internal fun StatusPortrait(sheet: PortraitSheet, resolved: PortraitState.Resolved, size: Dp = PALLayout.portrait) {
    val bitmap by key(sheet.sha256) {
        produceState<android.graphics.Bitmap?>(null) {
            value = withContext(Dispatchers.Default) {
                android.graphics.BitmapFactory.decodeByteArray(sheet.bytes, 0, sheet.bytes.size)
            }
        }
    }
    val index = sheet.frames[resolved.expression] ?: 0
    val face by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, bitmap, index) {
        val source = bitmap
        value = if (source == null || sheet.columns <= 0 || sheet.cell <= 0 || index < 0 ||
            source.width / sheet.cell < sheet.columns || index / sheet.columns >= source.height / sheet.cell) null
        else withContext(Dispatchers.Default) {
            android.graphics.Bitmap.createBitmap(source, (index % sheet.columns) * sheet.cell,
                (index / sheet.columns) * sheet.cell, sheet.cell, sheet.cell).asImageBitmap()
        }
    }
    val ring = when (resolved.tone) { "attention" -> color(sheet.palette["portraitAttention"], MaterialTheme.colorScheme.tertiary); "warm" -> color(sheet.palette["portraitWarm"], MaterialTheme.colorScheme.secondary); else -> color(sheet.palette["portraitAccent"], MaterialTheme.colorScheme.primary) }
    Box(Modifier.size(size).clip(CircleShape)
        .background(Brush.verticalGradient(listOf(color(sheet.palette["portraitTop"], MaterialTheme.colorScheme.secondaryContainer), color(sheet.palette["portraitBottom"], MaterialTheme.colorScheme.surfaceContainerHigh))))
        .border(PALLayout.focusStroke, ring, CircleShape)) {
        face?.let { Image(it, contentDescription = null, modifier = Modifier.fillMaxSize()) }
    }
}
