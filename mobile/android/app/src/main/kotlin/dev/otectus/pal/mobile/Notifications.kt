package dev.otectus.pal.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.otectus.pal.mobile.data.DesktopNotice
import dev.otectus.pal.mobile.protocol.Approval

/** Channels, request alerts and desktop notices. Lock-screen copies never show request or conversation detail. */
internal object PALNotifications {
    const val MONITORING = "cere-monitoring"
    const val REQUESTS = "cere-requests"
    const val COMPLETIONS = "cere-completions"
    const val PROBLEMS = "cere-problems"
    const val TIMERS = "cere-timers"
    const val MONITORING_ID = 41

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        fun channel(id: String, name: String, importance: Int, description: String, badge: Boolean = true) =
            NotificationChannel(id, name, importance).apply { this.description = description; lockscreenVisibility = Notification.VISIBILITY_PRIVATE; setShowBadge(badge) }
        manager.createNotificationChannels(listOf(
            channel(MONITORING, context.getString(R.string.notice_pal_connection), NotificationManager.IMPORTANCE_LOW, context.getString(R.string.notice_shows_when_pal_is_monitoring_your_paired_desktop), badge = false),
            channel(REQUESTS, context.getString(R.string.notice_pal_requests), NotificationManager.IMPORTANCE_HIGH, context.getString(R.string.notice_approval_and_question_requests_from_the_paired_pal)),
            channel(COMPLETIONS, context.getString(R.string.notice_replies_ready), NotificationManager.IMPORTANCE_DEFAULT, context.getString(R.string.notice_a_desktop_conversation_finished_its_reply)),
            channel(PROBLEMS, context.getString(R.string.notice_conversation_problems), NotificationManager.IMPORTANCE_DEFAULT, context.getString(R.string.notice_a_desktop_conversation_stopped_or_reported_an_error)),
            channel(TIMERS, context.getString(R.string.notice_desktop_timers), NotificationManager.IMPORTANCE_HIGH, context.getString(R.string.notice_timers_set_from_this_phone_on_the_desktop)),
        ))
    }

    /** Request alerts reach the person only with notifications allowed and the requests channel on. */
    fun requestAlertsEnabled(context: Context): Boolean {
        val compat = NotificationManagerCompat.from(context)
        if (!compat.areNotificationsEnabled()) return false
        val channel = context.getSystemService(NotificationManager::class.java).getNotificationChannel(REQUESTS)
        return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun approvalId(id: String) = ("approval:$id").hashCode()
    private fun noticeId(notice: DesktopNotice) = (if (notice.kind == "timer") "timer:${notice.timerId}" else "notice:${notice.sessionId}").hashCode()

    private fun open(context: Context, requestCode: Int, action: String, extra: Pair<String, String>? = null): PendingIntent =
        PendingIntent.getActivity(context, requestCode, Intent(context, MainActivity::class.java).setAction(action)
            .apply { extra?.let { putExtra(it.first, it.second) } }
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    fun monitoring(context: Context, text: String): Notification {
        val stop = PendingIntent.getService(context, 1, Intent(context, MonitoringService::class.java).setAction(MonitoringService.ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(context, MONITORING)
            .setSmallIcon(R.drawable.ic_pal_notification)
            .setContentTitle(context.getString(R.string.notice_pal_mobile))
            .setContentText(text)
            .setContentIntent(open(context, 0, Intent.ACTION_MAIN))
            .addAction(0, context.getString(R.string.work_stop_monitoring), stop)
            .setOngoing(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setSilent(true)
            .build()
    }

    fun approval(context: Context, approval: Approval, problem: String? = null): Notification {
        val review = open(context, approvalId(approval.id), MainActivity.ACTION_REVIEW, MainActivity.EXTRA_APPROVAL_ID to approval.id)
        val builder = NotificationCompat.Builder(context, REQUESTS)
            .setSmallIcon(R.drawable.ic_pal_notification)
            .setContentTitle(problem ?: context.getString(R.string.notice_pal_needs_your_review))
            .setContentText(if (problem != null) context.getString(R.string.notice_open_pal_to_check, approval.title) else "${approval.kind.replaceFirstChar(Char::uppercase)} · ${approval.title}")
            .setContentIntent(review)
            .setAutoCancel(true)
            // Re-posting the same request must not sound or vibrate again.
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(context, REQUESTS).setSmallIcon(R.drawable.ic_pal_notification).setContentTitle(context.getString(R.string.notice_pal_request)).setContentText(context.getString(R.string.notice_unlock_to_review)).build())
        if (problem == null && "deny" in approval.choices) {
            val deny = PendingIntent.getBroadcast(context, approvalId(approval.id), Intent(context, DenyReceiver::class.java).setData(Uri.parse("pal://deny/${approval.id}")).putExtra("approvalId", approval.id), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            builder.addAction(android.R.drawable.ic_delete, context.getString(R.string.notice_deny), deny)
        }
        return builder.build()
    }

    /** Builds the alert for a desktop notice, or null for kinds the phone does not announce. */
    fun notice(context: Context, notice: DesktopNotice): Pair<Int, Notification>? {
        val (channel, title, text) = when (notice.kind) {
            "complete" -> Triple(COMPLETIONS, context.getString(R.string.notice_reply_ready), notice.title ?: context.getString(R.string.notice_a_conversation_finished))
            "error" -> Triple(PROBLEMS, context.getString(R.string.notice_a_conversation_reported_a_problem), context.getString(R.string.notice_open_pal_to_review_activity, notice.title ?: context.getString(R.string.current_conversation)))
            "interrupted" -> Triple(PROBLEMS, context.getString(R.string.notice_a_conversation_stopped), notice.title ?: context.getString(R.string.current_conversation))
            "timer" -> Triple(TIMERS, context.getString(R.string.desktop_timer), notice.label ?: context.getString(R.string.notice_your_desktop_timer_finished))
            else -> return null
        }
        val id = noticeId(notice)
        val tap = if (notice.kind == "timer") open(context, id, MainActivity.ACTION_OPEN_DESKTOP)
            else open(context, id, MainActivity.ACTION_OPEN_SESSION, MainActivity.EXTRA_SESSION_ID to (notice.sessionId ?: ""))
        val publicTitle = if (notice.kind == "timer") context.getString(R.string.notice_pal_timer) else context.getString(R.string.notice_pal_conversation_update)
        return id to NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_pal_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_pal_notification).setContentTitle(publicTitle).setContentText(context.getString(R.string.notice_unlock_to_view)).build())
            .build()
    }
}
