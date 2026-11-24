import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// A constrained provider schema is rendered here instead of exposing raw JSON. Unknown future field
// types remain visible as text fields, so an older PAL can still preserve a user's choice.
ColumnLayout {
    id: editor
    property var schema: []
    property var values: ({})
    property string operation: "chat"
    property string variant: ""
    property bool editorEnabled: true
    /** Options a screen already shows another way; one that was saved stays visible, so it can be changed. */
    property var hiddenKeys: []
    // A list from the broker is not an Array to Array.isArray.
    readonly property var fields: (schema?.fields || schema?.properties || schema || []).filter(field => {
        const operations = field.operations || []
        const variants = field.variants || []
        return (!operations.length || operations.includes(editor.operation)) && (!variants.length || variants.includes(editor.variant)) && (editor.hiddenKeys.indexOf(field.key) < 0 || editor.values[field.key] !== undefined)
    })
    visible: fields.length > 0
    Layout.fillWidth: true
    spacing: Theme.space2

    function keyFor(field, index) { return field.key || field.id || ("option" + index) }
    function current(field, index) {
        const key = keyFor(field, index)
        return values[key] !== undefined ? values[key] : field.default
    }
    function setOption(key, value) {
        const next = Object.assign({}, values)
        if (value === undefined || value === null || value === "") delete next[key]
        else next[key] = value
        values = next
    }
    function reset(next) { values = Object.assign({}, next || {}) }

    Repeater {
        model: editor.fields
        delegate: ColumnLayout {
            required property var modelData
            required property int index
            readonly property string optionKey: editor.keyFor(modelData, index)
            readonly property string optionType: modelData.type || "string"
            Layout.fillWidth: true
            spacing: Theme.space1

            CCheckBox {
                objectName: "providerOption_" + optionKey
                visible: optionType === "boolean"
                text: modelData.label || optionKey
                checked: editor.current(modelData, index) === true
                enabled: editor.editorEnabled
                Accessible.description: modelData.description || ""
                onToggled: editor.setOption(optionKey, checked)
            }
            CText {
                visible: optionType !== "boolean"
                text: modelData.label || optionKey
                color: Theme.muted
                font.pixelSize: Theme.secondary
            }
            CComboBox {
                id: choice
                objectName: "providerChoice_" + optionKey
                visible: optionType === "enum"
                Layout.fillWidth: true
                // An unset choice is the provider's own, not the first of the list.
                model: [{ id: "", label: "Provider default" }].concat(modelData.choices || [])
                textRole: "label"
                valueRole: "id"
                enabled: editor.editorEnabled
                Accessible.name: modelData.label || optionKey
                currentIndex: Math.max(0, model.findIndex(row => row.id === (editor.current(modelData, index) || "")))
                onActivated: editor.setOption(optionKey, currentValue)
            }
            CField {
                id: valueField
                objectName: "providerValue_" + optionKey
                visible: optionType !== "boolean" && optionType !== "enum"
                Layout.fillWidth: true
                text: {
                    const value = editor.current(modelData, index)
                    return value instanceof Array ? value.join(", ") : value === undefined || value === null ? "" : String(value)
                }
                placeholderText: modelData.required ? "Required" : "Provider default"
                enabled: editor.editorEnabled
                Accessible.name: modelData.label || optionKey
                onEditingFinished: {
                    const raw = text.trim()
                    if (optionType === "number") editor.setOption(optionKey, raw ? Number(raw) : undefined)
                    else if (optionType === "string-list") editor.setOption(optionKey, raw ? raw.split(",").map(value => value.trim()).filter(Boolean) : undefined)
                    else editor.setOption(optionKey, raw || undefined)
                }
            }
            CText {
                visible: !!modelData.description
                text: modelData.description || ""
                color: Theme.muted
                font.pixelSize: Theme.caption
                wrapMode: Text.Wrap
                Layout.fillWidth: true
            }
        }
    }
}
