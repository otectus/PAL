import QtQuick
import QtQuick.Controls
import QtTest
import "../../qml" as PAL

Item {
    id: scene
    width: 520; height: 600; visible: true
    QtObject {
        id: broker
        property bool connected: true
        property int nextId: 0
        property var calls: ({})
        property var state: ({})
        signal result(int id, var value)
        function rpc(method, params) { const id = ++nextId, next = Object.assign({}, calls); next[id] = { method: method, params: params }; calls = next; return id }
        function last() { return calls[nextId] }
        function reply(value) { result(nextId, value) }
        function reset() { nextId = 0; calls = ({}) }
    }
    Component { id: pickerComponent; PAL.ModelPicker { app: broker; width: 480; name: "fixture" } }
    Component { id: boxComponent; PAL.CComboBox { width: 200 } }
    Component { id: fieldComponent; PAL.CField { width: 200 } }
    Component { id: stableComponent; PAL.StableValue {} }
    SignalSpy { id: chosenSpy; signalName: "chosen" }
    SignalSpy { id: valueSpy; signalName: "valueChanged" }
    TestCase {
        name: "ModelPicker"
        when: windowShown
        property var subject: null
        function init() { broker.reset() }
        function cleanup() { if (subject) subject.destroy(); subject = null; chosenSpy.target = null; chosenSpy.clear() }
        function make(properties) { subject = createTemporaryObject(pickerComponent, scene, properties); verify(subject); chosenSpy.target = subject; return subject }
        function box() { return findChild(subject, "fixture") }
        function ids() { return subject.options.map(row => row.id) }
        function choose(id) { const index = subject.options.findIndex(row => row.id === id); verify(index >= 0, id); box().currentIndex = index; box().activated(index) }
        function list(count) { const rows = []; for (let i = 0; i < count; i++) rows.push({ id: "model-" + i, displayName: "Model " + i, detail: i + "K context" }); return rows }

        function test_whatCostsARequestIsAskedForWhenTheListOpens() {
            make({ provider: "mistral", operation: "embed", saved: "kept-model" })
            tryVerify(() => broker.nextId === 1); compare(broker.last().method, "models.choices"); compare(broker.last().params.known, true); compare(broker.last().params.operation, "embed")
            broker.reply({ models: [], live: false })
            compare(subject.value, "kept-model"); compare(box().currentText, "kept-model")
            box().popup.open(); tryVerify(() => broker.nextId === 2); verify(broker.last().params.known === undefined)
            broker.reply({ models: list(3), live: true })
            compare(subject.value, "kept-model"); compare(box().currentText, "kept-model · not listed"); box().popup.close()
            box().popup.open(); wait(50); compare(broker.nextId, 2); box().popup.close()
            mouseClick(findChild(subject, "fixtureRefresh")); compare(broker.last().params.refresh, true)
        }
        function test_aChoiceSurvivesListsAndAnIdCanBeEntered() {
            make({ provider: "ollama", operation: "embed" })
            tryVerify(() => broker.nextId === 1); verify(broker.last().params.known === undefined); broker.reply({ models: list(3), live: true })
            choose("model-2"); compare(subject.value, "model-2"); compare(chosenSpy.count, 1); compare(findChild(subject, "fixtureFacts").text, "2K context")
            subject.listed = list(2); compare(subject.value, "model-2"); compare(box().currentText, "model-2 · not listed")
            subject.listed = list(5); compare(box().currentText, "Model 2")
            choose(subject.customId); const field = findChild(subject, "fixtureCustom"); verify(field.visible); compare(field.text, "model-2")
            field.text = " own/model "; compare(subject.value, "own/model"); compare(box().currentText, "Enter a model ID…")
            subject.listed = list(4); compare(subject.value, "own/model"); verify(field.visible)
            choose("model-1"); verify(!field.visible); compare(subject.value, "model-1")
            choose(""); compare(subject.value, "")
        }
        function test_anotherProviderIsAnotherListAndALateAnswerIsNobodys() {
            make({ provider: "ollama" }); tryVerify(() => broker.nextId === 1)
            subject.provider = "mistral"; tryVerify(() => broker.nextId === 2)
            broker.result(1, { models: list(2), live: true }); compare(subject.models.length, 0)
            broker.result(2, { models: list(1), live: true, problem: "" }); compare(subject.models.length, 1)
        }
        function test_aListThatCannotLoadSaysSoAndAnIdStillWorks() {
            make({ provider: "mistral", operation: "ocr" }); tryVerify(() => broker.nextId === 1)
            broker.reply({ models: [{ id: "mistral-ocr-latest", displayName: "mistral-ocr-latest" }], live: false, problem: "Add an API key" })
            compare(findChild(subject, "fixtureProblem").text, "Add an API key"); verify(ids().indexOf("mistral-ocr-latest") > 0)
            choose(subject.customId); findChild(subject, "fixtureCustom").text = "x"; compare(subject.value, "x")
        }
        function test_aLongListIsBrowsedAndAGivenOneAsksNothing() {
            make({ given: list(20), accepts: model => model.id !== "model-0" }); wait(50); compare(broker.nextId, 0); verify(!findChild(subject, "fixtureRefresh").visible)
            compare(subject.models.length, 19)
            const browse = findChild(subject, "fixtureBrowse"); verify(browse.visible); mouseClick(browse)
            tryVerify(() => !!findChild(subject, "modelSearch")); findChild(subject, "modelSearch").text = "Model 17"; mouseClick(findChild(subject, "modelRow_0")); compare(subject.value, "model-17")
        }
    }
    TestCase {
        name: "KeptInput"
        when: windowShown
        function test_anEditableBoxTakesTyping() {
            const box = createTemporaryObject(boxComponent, scene, { editable: true, model: ["a", "b"] }); verify(box)
            box.forceActiveFocus(); tryVerify(() => box.contentItem.activeFocus); box.contentItem.selectAll(); keyClick("x"); keyClick("y"); tryCompare(box, "editText", "xy")
        }
        function test_aChoiceOutlivesListUpdates() {
            const rows = [{ id: "", label: "None" }, { id: "one", label: "One" }, { id: "two", label: "Two" }]
            const box = createTemporaryObject(boxComponent, scene, { textRole: "label", valueRole: "id", model: rows, keepsChoice: true, saved: "one" }); verify(box)
            compare(box.currentValue, "one")
            box.currentIndex = 2; box.activated(2); compare(box.choice, "two")
            box.model = rows.slice(); compare(box.currentValue, "two")
            box.model = [rows[0]]; compare(box.currentValue, ""); box.model = rows; compare(box.currentValue, "two")
            box.saved = "one"; compare(box.currentValue, "two", "the stored value did not change"); box.saved = ""; compare(box.currentValue, "")
        }
        function test_typedTextOutlivesStateUpdates() {
            const field = createTemporaryObject(fieldComponent, scene, { saved: "stored" }); verify(field); compare(field.text, "stored")
            field.text = "typed"; field.saved = "stored"; compare(field.text, "typed"); field.saved = "new"; compare(field.text, "new")
        }
        function test_aStableValueChangesOnlyWithItsContent() {
            const stable = createTemporaryObject(stableComponent, scene, { source: { list: [{ id: 1 }] } }); verify(stable)
            valueSpy.target = stable; valueSpy.clear()
            stable.source = { list: [{ id: 1 }] }; compare(valueSpy.count, 0)
            stable.source = { list: [{ id: 2 }] }; compare(valueSpy.count, 1); compare(stable.value.list[0].id, 2)
        }
    }
}
