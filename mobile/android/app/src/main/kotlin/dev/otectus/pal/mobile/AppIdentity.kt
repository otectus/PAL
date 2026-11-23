package dev.otectus.pal.mobile

import android.content.Context
import android.os.Build
import dev.otectus.pal.mobile.data.AppIdentity

internal fun mobileVersionLabel(versionName: String?, versionCode: Long): String =
    versionName?.trim()?.takeIf(String::isNotEmpty) ?: versionCode.toString()

internal fun installedAppIdentity(context: Context): AppIdentity {
    @Suppress("DEPRECATION")
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    return AppIdentity(
        mobileVersionLabel(info.versionName, info.longVersionCode),
        info.longVersionCode,
        context.packageName,
        Build.VERSION.RELEASE ?: "unknown",
        Build.VERSION.SDK_INT,
    )
}
