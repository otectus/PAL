package dev.otectus.pal.mobile

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// PAL's pearl shell and cyan display, adapted from the desktop avatar palette.
internal val Night = darkColorScheme(
    primary = Color(0xFF68ECED), onPrimary = Color(0xFF003638),
    primaryContainer = Color(0xFF163E43), onPrimaryContainer = Color(0xFFBEF5F3),
    secondary = Color(0xFFABC7D4), onSecondary = Color(0xFF17313C),
    secondaryContainer = Color(0xFF293E4A), onSecondaryContainer = Color(0xFFE0EFF0),
    tertiary = Color(0xFFFFCF83), onTertiary = Color(0xFF452C00),
    tertiaryContainer = Color(0xFF483821), onTertiaryContainer = Color(0xFFFFDEAC),
    background = Color(0xFF0B121B), onBackground = Color(0xFFEDF5FC),
    surface = Color(0xFF151B24), onSurface = Color(0xFFEDF5FC),
    surfaceDim = Color(0xFF0B121B), surfaceBright = Color(0xFF354350),
    surfaceContainerLowest = Color(0xFF090F16), surfaceContainerLow = Color(0xFF101820),
    surfaceContainer = Color(0xFF18232D), surfaceContainerHigh = Color(0xFF1E2B35),
    surfaceContainerHighest = Color(0xFF293944), surfaceVariant = Color(0xFF24343D),
    onSurfaceVariant = Color(0xFFAEC1CC), outline = Color(0xFF849CA7), outlineVariant = Color(0xFF354755),
    error = Color(0xFFFFB2B9), onError = Color(0xFF5F1422),
    errorContainer = Color(0xFF4B2730), onErrorContainer = Color(0xFFFFDADF),
    inverseSurface = Color(0xFFE2EBF1), inverseOnSurface = Color(0xFF1B2B37), inversePrimary = Color(0xFF006581),
    surfaceTint = Color(0xFF68ECED),
)

internal val Day = lightColorScheme(
    primary = Color(0xFF00646A), onPrimary = Color.White,
    primaryContainer = Color(0xFFC6EFED), onPrimaryContainer = Color(0xFF073D40),
    secondary = Color(0xFF475F6C), onSecondary = Color.White,
    secondaryContainer = Color(0xFFDDE9E9), onSecondaryContainer = Color(0xFF1D3847),
    tertiary = Color(0xFF815000), onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFE6BD), onTertiaryContainer = Color(0xFF593900),
    background = Color(0xFFF3F6F6), onBackground = Color(0xFF13272B),
    surface = Color(0xFFFDFEFE), onSurface = Color(0xFF13272B),
    surfaceDim = Color(0xFFD9E3E9), surfaceBright = Color.White,
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFF3F6F6),
    surfaceContainer = Color(0xFFEAF0F0), surfaceContainerHigh = Color(0xFFE2EAEA),
    surfaceContainerHighest = Color(0xFFD7E3E3), surfaceVariant = Color(0xFFDEE8E8),
    onSurfaceVariant = Color(0xFF455B60), outline = Color(0xFF597277), outlineVariant = Color(0xFFC3D1D1),
    error = Color(0xFFAB3043), onError = Color.White,
    errorContainer = Color(0xFFFFDDE0), onErrorContainer = Color(0xFF741729),
    inverseSurface = Color(0xFF263845), inverseOnSurface = Color(0xFFEBF2F7), inversePrimary = Color(0xFF68ECED),
    surfaceTint = Color(0xFF00646A),
)

/** Spacing, control anatomy and window constraints shared by every destination. */
internal object PALLayout {
    val none = 0.dp
    val hairline = 1.dp
    val focusStroke = 2.dp
    val tight = 4.dp
    val small = 8.dp
    val groupGap = 12.dp
    val gutter = 16.dp
    val inset = 20.dp
    val sectionGap = 24.dp
    val spacious = 32.dp

    val iconSmall = 16.dp
    val iconMedium = 20.dp
    val icon = 24.dp
    val portraitCompact = 36.dp
    val portrait = 40.dp
    val target = 48.dp
    val primaryHeight = 56.dp
    val headerHeight = 60.dp
    val brandMark = 72.dp
    val fabClearance = 96.dp
    val scanFrame = 260.dp

    val shortField = 136.dp
    val fieldWidth = 176.dp
    val statusWidth = 176.dp
    val codeEditorHeight = 120.dp
    val notesEditorHeight = 160.dp
    val comparisonHeight = 180.dp
    val desktopPreviewHeight = 360.dp
    val previewHeight = 420.dp
    val dialogBodyHeight = 480.dp
    val sheetBodyHeight = 560.dp

    val noticeWidth = 440.dp
    val formWidth = 560.dp
    val readingWidth = 720.dp
    val largeTextPhoneWidth = 500.dp
    val minimalChromeHeight = 280.dp
    val compactHeight = 420.dp
    val landscapeWidth = 440.dp
    val railWidth = 600.dp
}

internal object PALShape {
    val userMessage = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 4.dp)
}

internal object PALMotion {
    val feedback = androidx.compose.animation.core.tween<Color>(
        durationMillis = 120, easing = androidx.compose.animation.core.FastOutSlowInEasing)
    val disclosure = androidx.compose.animation.core.tween<androidx.compose.ui.unit.IntSize>(
        durationMillis = 160, easing = androidx.compose.animation.core.LinearOutSlowInEasing)
}

/** Fixed roles for the camera, machine-readable codes, and user-applied image marks. */
internal object PALMedia {
    val backdrop = Color.Black
    val onBackdrop = Color.White
    val scannerOverlay = backdrop.copy(alpha = .84f)
    val annotationPrimary = Color(0xFFE53935)
    val annotationHighlight = Color(0xFFFDD835)
}

internal val terminalType = androidx.compose.ui.text.TextStyle(
    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, fontSize = 13.sp, lineHeight = 17.sp,
)

private val PALType = Typography().run {
    copy(
        headlineLarge = headlineLarge.copy(fontSize = 30.sp, lineHeight = 36.sp, letterSpacing = (-0.8).sp, fontWeight = FontWeight.SemiBold),
        headlineSmall = headlineSmall.copy(fontSize = 26.sp, lineHeight = 32.sp, letterSpacing = (-0.5).sp, fontWeight = FontWeight.SemiBold),
        titleLarge = titleLarge.copy(fontSize = 21.sp, lineHeight = 27.sp, letterSpacing = (-0.3).sp, fontWeight = FontWeight.SemiBold),
        titleMedium = titleMedium.copy(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = bodyLarge.copy(fontSize = 16.sp, lineHeight = 25.sp, letterSpacing = 0.1.sp),
        bodyMedium = bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp),
        bodySmall = bodySmall.copy(fontSize = 13.sp, lineHeight = 19.sp),
        labelSmall = labelSmall.copy(fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.15.sp),
    )
}
private val PALShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp), small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp), large = RoundedCornerShape(18.dp), extraLarge = RoundedCornerShape(24.dp),
)

@Composable fun PALTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Night else Day, typography = PALType, shapes = PALShapes, content = content)
}

internal object PALBrand {
    val surface: Color @Composable get() = if (isSystemInDarkTheme()) Color(0xFF15333A) else Color(0xFF15373C)
    val onSurface: Color @Composable get() = if (isSystemInDarkTheme()) Color(0xFFE5F8F7) else Color(0xFFF1FAF9)
}
