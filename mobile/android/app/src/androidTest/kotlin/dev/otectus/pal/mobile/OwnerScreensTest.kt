package dev.otectus.pal.mobile

import android.content.Intent
import android.view.KeyEvent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.platform.app.InstrumentationRegistry
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.traits
import dev.otectus.pal.mobile.protocol.Session
import kotlinx.serialization.json.JsonObject
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/**
 * A phone with full access, paired to a real desktop named by its ID, opens every screen it has: each kind of conversation's
 * settings and menus, New chat for every provider, Work, Desktop, the Inbox and all of Settings. Nothing is sent, changed or
 * answered. It fails when a screen does not open, when the app ends, or when the desktop could not read what a screen asked.
 */
class OwnerScreensTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val arguments get() = InstrumentationRegistry.getArguments()
    private val repository get() = (compose.activity.application as PALApp).repository
    private fun text(id: Int, vararg args: Any) = compose.activity.getString(id, *args)

    private fun count(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes(atLeastOneRootRequired = false).size
    private fun await(what: String, timeout: Long = 20_000, check: () -> Boolean) {
        try { compose.waitUntil(timeout) { check() } } catch (late: Throwable) { throw AssertionError("$where: $what did not appear. On screen: ${onScreen()}", late) }
        readable()
    }
    private var where = "start"
    private fun onScreen(): List<String> = compose.onAllNodes(SemanticsMatcher("has text") { it.config.getOrNull(SemanticsProperties.Text) != null }).fetchSemanticsNodes(atLeastOneRootRequired = false)
        .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.map { it.text }.filter { it.isNotBlank() }.distinct().take(120)
    /** What the desktop answers when it could not read a request: a screen asked for something in a way it does not take. */
    private fun readable() {
        val refused = onScreen().filter { "Review the input and desktop diagnostics" in it || "does not have access to that operation" in it || "Unknown mobile operation" in it }
        check(refused.isEmpty()) { "$where: the desktop refused what this screen asked: $refused" }
    }
    private fun shows(label: String) = count(hasText(label)) > 0
    /** Acts on the control itself: a list that is still filling in can move it away from a touch on a small screen. */
    private fun tap(label: String, inside: SemanticsMatcher? = null) {
        val matcher = (if (inside == null) hasText(label) else hasText(label) and hasAnyAncestor(inside)) and hasClickAction() and isEnabled()
        if (inside == null) seek(label)
        await("“$label”") { count(matcher) > 0 }
        compose.onAllNodes(matcher)[0].let { node -> runCatching { node.performScrollTo() }; node.performSemanticsAction(SemanticsActions.OnClick) }
        compose.waitForIdle()
    }
    private fun describe(label: String) { val matcher = hasContentDescription(label) and hasClickAction(); await("“$label”") { count(matcher) > 0 }; compose.onAllNodes(matcher)[0].performClick(); compose.waitForIdle() }
    /** Content further down a lazy list is not there until it is scrolled to. */
    private fun seek(label: String) {
        if (count(hasText(label)) == 0) for (index in 0 until count(hasScrollToNodeAction())) if (runCatching { compose.onAllNodes(hasScrollToNodeAction())[index].performScrollToNode(hasText(label)) }.isSuccess) break
    }
    private fun reach(label: String) {
        seek(label)
        await("“$label”") { count(hasText(label)) > 0 }
        runCatching { compose.onAllNodes(hasText(label))[0].performScrollTo() }
    }
    private fun settle(millis: Long = 1_200) { val end = System.currentTimeMillis() + millis; while (System.currentTimeMillis() < end) { compose.mainClock.advanceTimeBy(100); compose.waitForIdle(); Thread.sleep(50) }; readable() }
    private fun windows() = count(isDialog()) + count(isPopup())
    private fun back() { InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); compose.waitForIdle() }
    /** Closes whatever lies over the screen, so one step cannot cover the next. */
    private fun clear() { repeat(6) { if (windows() == 0) return; back(); settle(400) }; check(windows() == 0) { "$where: a window stayed open: ${onScreen()}" } }
    private fun step(name: String, work: () -> Unit) { where = name; work(); readable(); println("OWNER_WALK: $name") }
    private fun destination(label: Int) {
        clear()
        val matcher = hasText(text(label)) and isSelectable()
        repeat(3) { if (count(matcher) == 0) { back(); settle(300) } }
        await(text(label)) { count(matcher) > 0 }
        compose.onAllNodes(matcher)[0].performClick(); compose.waitForIdle()
    }
    private fun workTab(id: Int, millis: Long = 800) {
        clear()
        val matcher = hasText(text(id)) and SemanticsMatcher.expectValue(SemanticsProperties.Role, androidx.compose.ui.semantics.Role.Tab)
        await("the ${text(id)} tab") { count(matcher) > 0 }
        compose.onAllNodes(matcher).let { nodes -> nodes[nodes.fetchSemanticsNodes().indexOfFirst { it.boundsInRoot.top < 600f }.coerceAtLeast(0)] }.let { node -> runCatching { node.performScrollTo() }; node.performClick() }
        settle(millis)
    }
    private fun openConversation(session: Session) {
        clear()
        // As a notification opens it. The rule follows this activity by the intent it was started with, so that one is put back.
        val started = compose.activity.intent
        compose.activityRule.scenario.onActivity { it.startActivity(Intent(it, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_SESSION).putExtra(MainActivity.EXTRA_SESSION_ID, session.id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
        await(session.title) { count(hasText(session.title)) > 0 && count(hasContentDescription(text(R.string.chat_options))) > 0 && repository.state.value.selectedSessionId == session.id }
        compose.activity.runOnUiThread { compose.activity.intent = started }
    }
    private fun menu(label: String): Boolean {
        clear(); describe(text(R.string.chat_options))
        if (!shows(label)) { clear(); return false }
        tap(label, isPopup()); settle(500)
        return true
    }

    private fun conversationSettings(session: Session) = step("Conversation settings · ${session.title}") {
        check(menu(text(R.string.chat_settings))) { "Conversation settings is not in the menu" }
        await("the sheet") { shows(text(R.string.conversation_section)) }
        if (session.canConfigure) {
            reach(text(R.string.conversation_model_tools))
            await("the models") { count(hasText(text(R.string.conversation_refresh_models)) and isEnabled()) > 0 }
        }
        listOf(R.string.extras_folder, R.string.conversation_style, R.string.conversation_results_schedules).forEach { reach(text(it)) }
        tap(text(R.string.conversation_show)); settle()
        await("its results") { count(hasText(text(R.string.action_refresh)) and isEnabled()) > 0 }
        if (session.canConfigure && session.model != null) check(!shows(text(R.string.conversation_models_unavailable)) && !shows(text(R.string.conversation_no_models_loaded))) { "the models could not be listed: ${onScreen()}" }
        tap(text(R.string.action_close)); settle(400); clear()
    }

    @Test fun everyScreenOpensOnAPhoneWithFullAccess() {
        val desktopId = arguments.getString("palExpectedDesktopId"); val ids = arguments.getString("palOwnerSessions")?.split(',').orEmpty().filter(String::isNotBlank)
        assumeTrue("Needs an explicitly selected paired desktop and its conversations", desktopId != null && ids.isNotEmpty())
        await("the desktop", 60_000) { repository.state.value.let { state -> state.connection is ConnectionState.Online && state.owner && ids.all { id -> state.sessions.any { it.id == id } } } }
        check(repository.state.value.desktop?.desktopId == desktopId) { "This phone is paired to another desktop" }
        val sessions = ids.map { id -> repository.state.value.sessions.first { it.id == id } }

        for (session in sessions) {
            step("Conversation · ${session.title}") { openConversation(session); settle() }
            // The list names a conversation; what it can do is known once it is open.
            conversationSettings(repository.state.value.sessions.first { it.id == session.id })
            step("Voice · ${session.title}") { if (menu(text(R.string.voice_settings))) { settle(); clear() } }
            step("Clock · ${session.title}") { if (menu(text(R.string.clock_menu))) { await("the clock") { shows(text(R.string.clock_title)) }; settle(); clear() } }
            step("Activity · ${session.title}") { if (menu(text(R.string.activity_label))) { settle(); clear() } }
            step("Pinned replies · ${session.title}") { if (menu(text(R.string.pinned_replies))) { settle(); clear() } }
            step("Timed media · ${session.title}") { if (menu("Generate video or music…")) { settle(); clear() } }
            step("Collections · ${session.title}") { if (menu("xAI document collections…")) { settle(); clear() } }
            step("Attach · ${session.title}") {
                val attach = hasContentDescription(text(R.string.attach_image)) and hasClickAction()
                if (count(attach) > 0) { compose.onAllNodes(attach)[0].performClick(); compose.waitForIdle(); if (shows(text(R.string.refs_add))) { tap(text(R.string.refs_add), isPopup()); settle() }; clear() }
            }
        }
        step("New chat") {
            destination(R.string.nav_chats); settle(300)
            describe(text(R.string.new_chat)); await("New chat") { shows(text(R.string.mobile_new_conversation)) }
        }
        val offered = repository.state.value.providers.filterValues { (it as? JsonObject)?.isTrue("remoteExecution") == true }.keys
        for (id in offered) step("New chat · $id") {
            val label = repository.state.value.traits(id).label
            val chip = hasText(label) and isSelectable()
            if (count(chip) > 0) { compose.onAllNodes(chip)[0].let { node -> runCatching { node.performScrollTo() }; node.performClick() }; settle(700) }
        }
        step("New chat closes") { tap(text(R.string.action_close)); settle(400); clear() }
        step("Desktop history") { describe(text(R.string.conversation_actions)); if (shows(text(R.string.import_history))) { tap(text(R.string.import_history), isPopup()); settle(); await("the history to be read", 60_000) { count(hasText(text(R.string.action_close)) and isEnabled()) > 0 }; tap(text(R.string.action_close)); settle(300) }; clear() }
        step("Handoff") {
            // The newest conversation is at the top of the list, clear of New chat on the smallest screen.
            val handoff = hasContentDescription(text(R.string.hand_off_session, sessions.last().title)) and hasClickAction()
            if (count(handoff) == 0) runCatching { compose.onAllNodes(hasScrollToNodeAction())[0].performScrollToNode(handoff) }
            if (count(handoff) > 0) { compose.onAllNodes(handoff)[0].performClick(); settle(); await("the handoff to be read") { count(hasText(text(R.string.action_close)) and isEnabled()) > 0 }; tap(text(R.string.action_close)); settle(300) }
            clear()
        }
        step("Inbox") { destination(R.string.nav_inbox); settle() }
        step("Desktop") { destination(R.string.nav_desktop); settle() }
        step("Work") { destination(R.string.nav_work); settle() }
        for (tab in listOf(R.string.work_tab_files, R.string.work_tab_changes, R.string.work_tab_library, R.string.work_tab_runs, R.string.work_tab_research, R.string.work_tab_canvas, R.string.tools_tab_shelf, R.string.work_tab_notes, R.string.work_tab_accounts, R.string.work_tab_terminal))
            step("Work · ${text(tab)}") { workTab(tab, 1_500) }
        for (label in listOf(R.string.media_title, R.string.docs_write, R.string.tools_sketch)) step("Library · ${text(label)}") { workTab(R.string.work_tab_library); if (shows(text(label))) { tap(text(label)); settle(); clear() } }
        for (label in listOf(R.string.lab_session, R.string.tools_command)) step("Runs · ${text(label)}") { workTab(R.string.work_tab_runs); runCatching { reach(text(label)) }; if (shows(text(label))) { tap(text(label)); settle(); clear() } }
        step("Model access") { workTab(R.string.work_tab_files); describe(text(R.string.conversation_actions)); if (shows(text(R.string.work_model_access))) { tap(text(R.string.work_model_access), isPopup()); settle() }; clear() }

        for (group in listOf(R.string.connection_settings, R.string.appearance_alerts, R.string.assistant_memory, R.string.desktop_access, R.string.pairing_maintenance)) step("Settings · ${text(group)}") {
            destination(R.string.nav_settings); settle(300)
            seek(text(group))
            if (shows(text(group))) { tap(text(group)); settle() }
        }
        step("Memory") { destination(R.string.nav_settings); tap(text(R.string.assistant_memory)); settle(500); if (shows(text(R.string.mobile_open_memory))) { tap(text(R.string.mobile_open_memory)); settle(); describe(text(R.string.mobile_back_to_settings)) } }
        for (section in listOf(R.string.owner_section_access_and_working_profile, R.string.owner_section_paired_devices, R.string.owner_section_power_session, R.string.owner_section_keys_and_connections, R.string.owner_section_accounts,
            R.string.owner_section_tool_servers, R.string.owner_section_usage_and_budget, R.string.owner_section_projects, R.string.owner_section_working_setups, R.string.owner_section_specialists, R.string.owner_section_routines, R.string.owner_section_skills,
            R.string.owner_section_knowledge_collections, R.string.owner_section_saved_scripts, R.string.owner_section_workspace_history, R.string.owner_section_desktop_settings, R.string.owner_section_local_models, R.string.owner_section_health_and_backups))
            step("This computer · ${text(section)}") {
                destination(R.string.nav_settings); settle(200); tap(text(R.string.owner_settings)); settle(300)
                if (shows(text(R.string.settings_all_computer))) { tap(text(R.string.settings_all_computer)); settle(200) }
                reach(text(section)); tap(text(section)); settle(1_500)
                await("the section") { shows(text(R.string.settings_all_computer)) }
            }
        check(repository.state.value.connection is ConnectionState.Online) { "The connection was lost on the way: ${repository.state.value.connection}" }
        println("OWNER_WALK: every screen opened")
    }
}
