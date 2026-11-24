import QtQuick
import QtTest
import "../../qml" as PAL

Item {
    id: scene
    width: 720; height: 900; visible: true
    QtObject {
        id: broker
        property bool connected: true
        property int nextId: 0
        property var calls: ({})
        property var state: ({ providerOrder: ["codex", "openrouter", "openai", "ollama"], providerTraits: { codex: { label: "Codex", kind: "native" }, openrouter: { label: "OpenRouter", kind: "api" }, openai: { label: "OpenAI", kind: "api" } }, settings: {} })
        signal result(int id, var value)
        function rpc(method, params) { const id = ++nextId, next = Object.assign({}, calls); next[id] = { method: method, params: params }; calls = next; return id }
        function reply(id, value) { result(id, value) }
        function idFor(method, occurrence) { let found = 0; for (const id of Object.keys(calls)) if (calls[id].method === method && ++found === (occurrence || 1)) return Number(id); return -1 }
        function reset() { nextId = 0; calls = ({}) }
    }
    Component { id: browserComponent; PAL.ModelBrowser { app: broker; width: 640 } }
    Component { id: pickerComponent; PAL.ProviderAccountPicker { app: broker; width: 640; name: "fixture" } }
    Component { id: bridgeComponent; PAL.LiteLlmBridge { app: broker } }
    SignalSpy { id: chosenSpy; signalName: "chosen" }
    SignalSpy { id: preferSpy; signalName: "prefer" }

    readonly property var models: [
        { id: "anthropic/claude", displayName: "Claude", contextLength: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, capabilities: ["images", "local-tools", "reasoning"], detail: "200K context", supportedParameters: ["tools", "reasoning"] },
        { id: "small/plain:free", displayName: "Plain", contextLength: 8192, pricing: { prompt: "0", completion: "0" }, free: true, capabilities: ["no-local-tools"], detail: "8K context · free", expires: "2026-12-31" },
        { id: "google/gemini", displayName: "Gemini", contextLength: 1048576, pricing: { prompt: "0.000001", completion: "0.000002" }, capabilities: ["images", "local-tools"], detail: "1M context" },
        { id: "openrouter/auto", displayName: "Auto Router", contextLength: 2000000, capabilities: ["local-tools", "structured-output"], detail: "2M context" }
    ]

    TestCase {
        name: "ModelBrowser"
        when: windowShown
        property var subject: null
        function init() { broker.reset() }
        function cleanup() { if (subject) subject.destroy(); subject = null; chosenSpy.target = null; preferSpy.target = null }
        function make(properties) { subject = createTemporaryObject(browserComponent, scene, Object.assign({ models: scene.models, provider: "openrouter" }, properties || {})); verify(subject); chosenSpy.target = subject; chosenSpy.clear(); preferSpy.target = subject; preferSpy.clear(); return subject }
        function ids() { return subject.rows.map(row => row.id) }
        function chip(id) { return findChild(subject, "modelChip_" + id) }

        function test_searchNarrowAndOrder() {
            make()
            compare(ids(), ["anthropic/claude", "small/plain:free", "google/gemini", "openrouter/auto"])
            const search = findChild(subject, "modelSearch"); search.text = "  AUTO router "; compare(ids(), ["openrouter/auto"]); verify(findChild(subject, "modelCount").visible); compare(findChild(subject, "modelCount").text, "1 of 4")
            search.text = "nothing such"; verify(findChild(subject, "modelNothing").visible); compare(ids().length, 0)
            search.text = ""; verify(!findChild(subject, "modelNothing").visible)
            // Only what tells models apart is offered, and what is chosen narrows together.
            for (const id of ["tools", "images", "reasoning", "structured-output", "free"]) verify(chip(id), id)
            mouseClick(chip("tools")); compare(ids(), ["anthropic/claude", "google/gemini", "openrouter/auto"]); mouseClick(chip("images")); compare(ids(), ["anthropic/claude", "google/gemini"])
            mouseClick(chip("tools")); mouseClick(chip("images")); compare(ids().length, 4)
            mouseClick(chip("free")); compare(ids(), ["small/plain:free"]); mouseClick(chip("free"))
            const sort = findChild(subject, "modelSort"); verify(sort.visible); compare(sort.count, 3)
            sort.currentIndex = 1; compare(ids()[0], "openrouter/auto"); sort.currentIndex = 2; compare(ids(), ["small/plain:free", "google/gemini", "anthropic/claude", "openrouter/auto"], "a model without a price comes after those with one")
        }
        function test_theArrowKeysWalkTheList() {
            make(); const search = findChild(subject, "modelSearch"); search.forceActiveFocus(); tryVerify(() => search.activeFocus)
            keyClick(Qt.Key_Down); tryVerify(() => findChild(subject, "modelRow_0").activeFocus); keyClick(Qt.Key_Down); tryVerify(() => findChild(subject, "modelRow_1").activeFocus)
            keyClick(Qt.Key_Return); compare(chosenSpy.count, 1); compare(chosenSpy.signalArguments[0][0], "small/plain:free")
            keyClick(Qt.Key_Up); tryVerify(() => findChild(subject, "modelRow_0").activeFocus); keyClick(Qt.Key_Up); tryVerify(() => search.activeFocus)
            search.text = "claude"; subject.provider = "mistral"; compare(search.text, "", "another provider's list starts unsearched")
        }
        function test_aListWithoutPricesIsNotOrderedByThem() {
            make({ models: [{ id: "a", displayName: "A", capabilities: [] }, { id: "b", displayName: "B", capabilities: [] }], provider: "mistral" })
            compare(findChild(subject, "modelSort").count, 2); verify(!chip("tools")); verify(!findChild(subject, "modelServedBy").visible)
        }
        function test_choosingShowsWhatTheCatalogSays() {
            make({ current: "small/plain:free" })
            verify(waitForRendering(subject))
            const row = findChild(subject, "modelRow_0"); verify(row); mouseClick(row); compare(chosenSpy.count, 1); compare(chosenSpy.signalArguments[0][0], "anthropic/claude")
            compare(findChild(subject, "modelChosen").text, "small/plain:free"); verify(!findChild(subject, "modelParameters").visible)
            subject.current = "anthropic/claude"; compare(findChild(subject, "modelParameters").text, "Takes tools, reasoning"); verify(findChild(subject, "modelRow_0").selected)
        }
        function test_whoServesAModelAndWhichArePreferred() {
            make({ current: "anthropic/claude", connectionId: "account-1", preferred: ["azure"] })
            const ask = findChild(subject, "modelServedBy"); verify(ask.visible); mouseClick(ask)
            const id = broker.idFor("provider.modelEndpoints"); verify(id > 0); compare(broker.calls[id].params, { provider: "openrouter", model: "anthropic/claude", connectionId: "account-1" }); verify(!ask.enabled)
            broker.reply(id, { endpoints: [{ provider: "Anthropic", slug: "anthropic", detail: "1M context", available: true, parameters: [] }, { provider: "Azure", slug: "azure", detail: "1M context", available: false, parameters: [] }] })
            tryVerify(() => !!findChild(subject, "modelUpstream_1")); compare(findChild(subject, "modelUpstream_0").text, "Anthropic · anthropic"); compare(findChild(subject, "modelPrefer_0").text, "Prefer"); compare(findChild(subject, "modelPrefer_1").text, "Preferred")
            mouseClick(findChild(subject, "modelPrefer_0")); compare(preferSpy.signalArguments[0][0], ["azure", "anthropic"]); mouseClick(findChild(subject, "modelPrefer_1")); compare(preferSpy.signalArguments[1][0], [])
            // A late answer about another model is not shown for this one.
            mouseClick(ask); const late = broker.idFor("provider.modelEndpoints", 2); subject.current = "google/gemini"; broker.reply(late, { endpoints: [{ provider: "Late", slug: "late", detail: "", available: true, parameters: [] }] }); wait(0); compare(subject.served.length, 0)
            mouseClick(ask); broker.reply(broker.idFor("provider.modelEndpoints", 3), { error: "API request failed (401)" }); tryCompare(findChild(subject, "modelServedError"), "text", "API request failed (401)")
        }
    }

    TestCase {
        name: "ProviderAccountPicker"
        when: windowShown
        function init() { broker.reset() }
        function test_providersAndTheirAccounts() {
            const picker = createTemporaryObject(pickerComponent, scene, { byName: true }); verify(picker)
            broker.reply(broker.idFor("connections.list"), [{ id: "1", kind: "openai", name: "Work" }, { id: "2", kind: "openai", name: "Old", migrated: true }, { id: "3", kind: "openrouter", name: "Router" }])
            compare(picker.kinds.map(row => row.label), ["Any provider", "Codex", "OpenRouter", "OpenAI", "Ollama"]); verify(!findChild(picker, "fixtureAccount").visible)
            picker.set("openai", "Work"); compare(picker.choices.map(row => row.label), ["OpenAI default", "Work"]); compare(findChild(picker, "fixtureAccount").currentText, "Work"); verify(findChild(picker, "fixtureAccount").visible)
            const provider = findChild(picker, "fixtureProvider"); provider.activated(2); compare(picker.provider, "openrouter"); compare(picker.account, "", "an account belongs to one provider")
            picker.set("openai", "Gone"); compare(picker.choices.map(row => row.label), ["OpenAI default", "Work", "Gone · missing"]); compare(findChild(picker, "fixtureAccount").currentText, "Gone · missing")
            picker.set("future", ""); compare(provider.currentText, "future", "a provider this version does not know stays chosen")
        }
        function test_helpersRunOnModelsPalCallsItself() {
            const picker = createTemporaryObject(pickerComponent, scene, { commandLine: false, anyLabel: "Helper model" })
            broker.reply(broker.idFor("connections.list"), [{ id: "1", kind: "openai", name: "Work" }])
            compare(picker.kinds.map(row => row.label), ["Helper model", "OpenRouter", "OpenAI", "Ollama"]); picker.set("openai", "1"); compare(findChild(picker, "fixtureAccount").currentText, "Work")
        }
    }

    TestCase {
        name: "LiteLlmBridge"
        when: windowShown
        readonly property var none: ({ source: "system", python: "python3", version: "", offered: "1.2.3", installed: false, busy: false, stage: "", error: "" })
        readonly property var kept: ({ source: "managed", python: "/p", version: "1.2.3", offered: "1.2.3", installed: true, busy: false, stage: "", error: "" })
        property var dialog: null
        function init() { broker.reset(); dialog = createTemporaryObject(bridgeComponent, scene); verify(dialog); dialog.openFor({ id: "account-1", name: "Bridge" }); tryCompare(dialog, "opened", true); broker.reply(broker.idFor("providerBridge.runtime"), none) }
        function cleanup() { dialog.close(); dialog.destroy(); dialog = null }
        function part(name) { return findChild(dialog.contentItem, name) || findChild(dialog.footer || dialog.contentItem, name) }

        function test_installIsAskedFirstThenFollowed() {
            verify(part("bridgeSummary").text.indexOf("PAL does not keep LiteLLM") === 0); verify(!part("bridgeRemove").visible)
            part("bridgeInstall").clicked(); verify(part("bridgeAsk").text.indexOf("Downloads LiteLLM 1.2.3") === 0); compare(broker.idFor("providerBridge.install"), -1, "nothing is downloaded by asking")
            part("bridgeBack").clicked(); compare(dialog.asking, ""); part("bridgeInstall").clicked(); part("bridgeConfirm").clicked()
            const id = broker.idFor("providerBridge.install"); compare(broker.calls[id].params, { confirmed: true }); broker.reply(id, Object.assign({}, none, { busy: true, stage: "Downloading LiteLLM and checking every file…" }))
            tryCompare(part("bridgeSummary"), "text", "Downloading LiteLLM and checking every file…"); verify(!part("bridgeTest").enabled); verify(part("bridgeCancel").visible)
            tryVerify(() => broker.idFor("providerBridge.runtime", 2) > 0, 2000); broker.reply(broker.idFor("providerBridge.runtime", 2), kept)
            tryCompare(part("bridgeSummary"), "text", "PAL keeps LiteLLM 1.2.3 in a folder of its own."); verify(part("bridgeRemove").visible); compare(part("bridgeInstall").text, "Install again…"); verify(!part("bridgeCancel").visible)
        }
        function test_aNewerVersionIsOfferedAndRemovalIsConfirmed() {
            dialog.show(Object.assign({}, kept, { version: "1.0.0" })); compare(part("bridgeInstall").text, "Update…"); verify(part("bridgeSummary").text.indexOf("This PAL offers 1.2.3.") > 0)
            part("bridgeRemove").clicked(); compare(part("bridgeConfirm").text, "Delete"); part("bridgeConfirm").clicked(); compare(broker.calls[broker.idFor("providerBridge.remove")].params, { confirmed: true })
        }
        function test_testingStartsOnlyThisAccountsWorker() {
            part("bridgeTest").clicked(); let id = broker.idFor("providerBridge.status"); compare(broker.calls[id].params, { connectionId: "account-1" }); verify(!part("bridgeTest").enabled)
            broker.reply(id, { available: true, running: true, version: "1.2.3" }); tryCompare(part("bridgeTested"), "text", "LiteLLM 1.2.3 is running."); verify(dialog.working)
            part("bridgeStop").clicked(); broker.reply(broker.idFor("providerBridge.stop"), { stopped: true }); tryVerify(() => part("bridgeTested").text.indexOf("Stopped.") === 0)
            part("bridgeTest").clicked(); broker.reply(broker.idFor("providerBridge.status", 2), { available: false, running: false, error: "LiteLLM is not installed: No module named 'litellm'" }); tryCompare(part("bridgeTested"), "text", "LiteLLM is not installed: No module named 'litellm'"); verify(!dialog.working)
        }
        function test_aFailedInstallSaysWhy() { dialog.show(Object.assign({}, none, { error: "a file did not match its fingerprint" })); verify(part("bridgeProblem").visible); compare(part("bridgeProblem").text, "a file did not match its fingerprint") }
    }
}
