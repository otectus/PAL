package dev.otectus.pal.mobile

import androidx.compose.ui.res.stringResource
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.ui.res.painterResource
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun ScannerScreen(onResult: (String) -> Unit, onBack: () -> Unit, onEnterOffer: () -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val context = LocalContext.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var cameraError by rememberSaveable { mutableStateOf<String?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) request.launch(Manifest.permission.CAMERA) }
    Box(Modifier.fillMaxSize().background(PALMedia.backdrop)) {
        if (granted && cameraError == null) CameraPreview(onResult) { cameraError = it }
        if (granted && cameraError == null) {
            Box(
                Modifier.align(Alignment.Center).size(PALLayout.scanFrame).border(PALLayout.tight, MaterialTheme.colorScheme.primary, MaterialTheme.shapes.large)
                    .semantics { contentDescription = strings.getString(R.string.scanner_qr_scanning_frame) },
            )
            Surface(
                color = PALMedia.scannerOverlay,
                contentColor = PALMedia.onBackdrop,
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.align(Alignment.BottomCenter).padding(PALLayout.gutter),
            ) {
                Column(Modifier.widthIn(max = PALLayout.noticeWidth).padding(PALLayout.gutter), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    Text(stringResource(R.string.scanner_point_at_the_pal_pairing_qr), fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                    Text(stringResource(R.string.scanner_only_signed_pal_pairing_offers_are_accepted), style = MaterialTheme.typography.bodySmall, color = PALMedia.onBackdrop.copy(alpha = .75f), textAlign = TextAlign.Center)
                }
            }
        } else {
            Surface(
                color = MaterialTheme.colorScheme.surface,
                contentColor = MaterialTheme.colorScheme.onSurface,
                shape = MaterialTheme.shapes.large,
                modifier = Modifier.align(Alignment.Center).padding(PALLayout.gutter).widthIn(max = PALLayout.formWidth),
            ) {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(PALLayout.sectionGap), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(PALLayout.gutter)) {
                    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.primaryContainer) {
                        Icon(painterResource(R.drawable.ic_scan), null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.padding(PALLayout.gutter).size(PALLayout.spacious))
                    }
                    Text(if (cameraError == null) stringResource(R.string.scanner_camera_access_needed) else stringResource(R.string.scanner_camera_unavailable), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                    Text(cameraError ?: stringResource(R.string.scanner_camera_access_is_used_only_to_scan_the), color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                    if (cameraError == null) Button({ request.launch(Manifest.permission.CAMERA) }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.scanner_allow_camera)) }
                    else Button({ cameraError = null }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.scanner_try_camera_again)) }
                    OutlinedButton({ context.open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))) }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.scanner_open_app_settings)) }
                    TextButton(onEnterOffer, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.paste_instead)) }
                }
            }
        }
        FilledTonalIconButton(onBack, Modifier.padding(PALLayout.groupGap).align(Alignment.TopStart).size(PALLayout.target), colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = PALMedia.scannerOverlay, contentColor = PALMedia.onBackdrop)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.go_back), tint = PALMedia.onBackdrop) }
    }
}

@Composable
private fun CameraPreview(onResult: (String) -> Unit, onError: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val view = remember(context) { PreviewView(context) }
    val resultCallback by rememberUpdatedState(onResult)
    val errorCallback by rememberUpdatedState(onError)
    AndroidView(factory = { view }, modifier = Modifier.fillMaxSize())
    DisposableEffect(view, owner) {
        val executor = Executors.newSingleThreadExecutor()
        val reader = MultiFormatReader().apply {
            setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
        }
        val preview = Preview.Builder().build().apply { surfaceProvider = view.surfaceProvider }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        val delivered = AtomicBoolean(false)
        var disposed = false
        var boundProvider: ProcessCameraProvider? = null
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (!disposed) runCatching {
                val provider = future.get()
                analysis.setAnalyzer(executor) { image ->
                    try {
                        val plane = image.planes[0]
                        val bytes = ByteArray(plane.buffer.remaining()).also(plane.buffer::get)
                        val source = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
                        val text = reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
                        if (text.startsWith("cere-pair://v1/") && delivered.compareAndSet(false, true))
                            view.post { if (!disposed) resultCallback(text) }
                    } catch (_: Exception) {
                        // A frame without a readable offer is expected, and so is a code the reader cannot make sense of.
                    } finally {
                        reader.reset()
                        image.close()
                    }
                }
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                boundProvider = provider
            }.onFailure { errorCallback(it.message ?: strings.getString(R.string.scanner_pal_could_not_start_this_camera)) }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            disposed = true
            analysis.clearAnalyzer()
            boundProvider?.unbind(preview, analysis)
            executor.shutdown()
        }
    }
}
