pragma Singleton
import QtQuick
// Shared colour, type, spacing and shape for every PAL surface.
// Palettes live in assets/avatars.json and follow the saved avatar.
// Text pairs meet WCAG 2.2 AA (4.5:1) and every control boundary 3:1 on the surfaces
// it sits on; tests/qml-tokens.test.ts checks both and keeps literals out of other files.
QtObject {
    // The native host and QML share the same catalog. Standalone component previews
    // read it directly (qmltestrunner enables local-file reads); production uses App.
    readonly property var palettes: typeof App !== "undefined" ? App.themes : catalogPalettes()
    readonly property var colors: typeof App !== "undefined" ? App.theme : AvatarCatalog.defaultEntry.palette
    function catalogPalettes() {
        var result = {}
        for (var entry of AvatarCatalog.entries) result[entry.id] = entry.palette
        return result
    }
    function paletteFor(avatarId) { return palettes[AvatarCatalog.avatarFor(avatarId).id] }
    readonly property color background: colors.background
    readonly property color sidebar: colors.sidebar
    readonly property color surface: colors.surface
    readonly property color raised: colors.raised
    readonly property color input: colors.input
    readonly property color selected: colors.selected
    readonly property color codeSurface: colors.codeSurface
    readonly property color userBubble: colors.userBubble
    readonly property color approvalSurface: colors.approvalSurface
    readonly property color questionSurface: colors.questionSurface
    readonly property color warningSurface: colors.warningSurface
    readonly property color dangerSurface: colors.dangerSurface
    readonly property color questionBadge: colors.questionBadge
    readonly property color permissionBadge: colors.permissionBadge
    readonly property color overlayScrim: colors.overlayScrim
    readonly property color line: colors.line
    readonly property color subtle: colors.subtle
    readonly property color userBubbleBorder: colors.userBubbleBorder
    readonly property color border: colors.border
    readonly property color borderHover: colors.borderHover
    readonly property color borderStrong: colors.borderStrong
    readonly property color primaryBorder: colors.primaryBorder
    readonly property color dangerBorder: colors.dangerBorder
    readonly property color warningBorder: colors.warningBorder
    readonly property color approvalBorder: colors.approvalBorder
    readonly property color activeBorder: colors.activeBorder
    readonly property color scrollThumb: colors.scrollThumb
    readonly property color scrollThumbHover: colors.scrollThumbHover
    readonly property color text: colors.text
    readonly property color muted: colors.muted
    readonly property color accent: colors.accent
    readonly property color accentText: colors.accentText
    readonly property color success: colors.success
    readonly property color danger: colors.danger
    readonly property color amber: colors.amber
    readonly property color warm: colors.warm
    readonly property color portraitSurface: colors.portraitSurface
    readonly property color portraitTop: colors.portraitTop
    readonly property color portraitBottom: colors.portraitBottom
    readonly property color portraitBorder: colors.portraitBorder
    readonly property color portraitAccent: colors.portraitAccent
    readonly property color portraitWarm: colors.portraitWarm
    readonly property color portraitAttention: colors.portraitAttention
    readonly property color portraitSpeech: colors.portraitSpeech
    readonly property color stageSurface: colors.stageSurface
    readonly property color stageBorder: colors.stageBorder
    readonly property color stageSpotlight: colors.stageSpotlight
    readonly property color stageSpotlightBorder: colors.stageSpotlightBorder
    readonly property color badgeSurface: colors.badgeSurface
    readonly property color petShadow: colors.petShadow
    readonly property color focus: accentText
    readonly property int focusWidth: 2
    readonly property color textDisabled: muted
    readonly property color info: accentText
    readonly property color transparent: "transparent"
    readonly property real disabledOpacity: 0.65
    readonly property int hairline: 1
    // Type scale (logical px); nothing is smaller than caption
    readonly property string font: "Adwaita Sans"
    readonly property int caption: 12
    readonly property int secondary: body
    readonly property int body: 14
    readonly property int message: 16
    readonly property int section: 18
    readonly property int title: 24
    readonly property int page: title
    readonly property int display: 28
    readonly property int wordmark: section
    readonly property int glyph: section
    readonly property string mono: "monospace"
    readonly property real interfaceScale: typeof App !== "undefined" ? App.state.settings?.interfaceScale || 1 : 1
    readonly property int iconSmall: 16
    readonly property int iconSize: 20
    readonly property real iconStroke: 1.5
    readonly property int controlHeight: 40
    readonly property int rowDetailHeight: 56
    readonly property int compactHeight: 32
    readonly property int minimumTarget: 24
    readonly property real bodyLeading: 1.25 // Multiplier of Qt's font line box, including its leading.
    readonly property real labelTracking: 0.6
    readonly property int tooltipDelay: 600
    readonly property int fieldWidth: 180
    readonly property int pickerWidth: 200
    readonly property int menuWidth: 224
    readonly property int menuMaxHeight: 256
    readonly property int fieldActionInset: 36
    readonly property int toolbarHeight: 36
    readonly property int dialogNarrow: 448
    readonly property int dialogWidth: 520
    readonly property int dialogWide: 608
    readonly property int dialogLarge: 720
    // Text selected for copying needs a stronger highlight than a selected list row.
    readonly property color selectionFill: accentText
    readonly property color selectionInk: background
    // Spacing scale
    readonly property int space1: 4
    readonly property int space2: 8
    readonly property int space3: 12
    readonly property int space4: 16
    readonly property int space5: 24
    readonly property int space6: 32
    readonly property int gutter: 20
    readonly property int avatarGalleryWide: 480
    readonly property int avatarTileWidth: 152
    readonly property int avatarTileCompact: 152
    readonly property int avatarTileHeight: 180
    readonly property int avatarPreviewSmall: 88
    readonly property int avatarPreviewWidth: 112
    // Field widths, multiline previews and responsive content areas.
    readonly property int fieldTiny: 80
    readonly property int fieldShort: 104
    readonly property int fieldMedium: 144
    readonly property int fieldLong: 280
    readonly property int editorShort: 88
    readonly property int editorMedium: 160
    readonly property int editorTall: 224
    readonly property int editorLarge: 280
    readonly property int rowTallHeight: 88
    readonly property int statusDot: 8
    readonly property int narrowPane: 352
    readonly property int compactPane: 400
    readonly property int formBreakpoint: 464
    readonly property int toolbarBreakpoint: 520
    readonly property int wideToolbar: 560
    readonly property int fullToolbar: 640
    readonly property int settingsBreakpoint: 700
    readonly property int twoColumnBreakpoint: 744
    readonly property int workspaceBreakpoint: 920
    readonly property int defaultWindowWidth: 1040
    readonly property int defaultWindowHeight: 780
    readonly property int panelWidth: 440
    readonly property int panelHeight: 860
    readonly property int sidebarMinimum: 208
    readonly property int sidebarDefault: 248
    readonly property int sidebarLimit: 360
    readonly property int railWidth: 64
    readonly property int paneMinimum: 360
    readonly property int paneDefault: 460
    readonly property int conversationMinimum: 416
    readonly property int settingsRailMinimum: 216
    readonly property int settingsRailWidth: 220
    readonly property int sessionRowHeight: 76
    readonly property int avatarSmall: 44
    readonly property int avatarMedium: 52
    readonly property int lineNumberWidth: 52
    readonly property int singleColumnMinimum: 488
    readonly property int attachmentThumbnail: 48
    readonly property int indicatorHeight: 4
    readonly property int labelIndent: 28
    readonly property int revealHold: 900
    readonly property int pageWidth: 1120
    readonly property int dashboardWidth: 1040
    readonly property int settingsWidth: 820
    readonly property int workflowWidth: 880
    readonly property int commandWidth: 680
    readonly property int commandHeight: 600
    readonly property int bubbleHeight: 460
    readonly property int previewHeight: 240
    readonly property int detailHeight: 128
    readonly property int thumbCompact: 64
    readonly property int thumbWidth: 96
    readonly property int thumbHeight: 72
    readonly property int composerCompact: 96
    readonly property int composerNormal: 124
    readonly property int activityCompact: 220
    readonly property int galleryRowHeight: 200
    // The native pet and preview renderer share the artwork's 12:13 reference rectangle.
    readonly property int petWidth: 192
    readonly property int petHeight: petWidth * 13 / 12
    readonly property int portraitSize: 64
    readonly property int motionPreviewHeight: 320
    readonly property int motionActorWidth: 208
    readonly property int motionSpotlight: 202
    readonly property int expressionBadgeWidth: 116
    readonly property int expressionBadgeHeight: 28
    readonly property int speechBarWidth: 3
    // Shape
    readonly property int radiusChip: 4
    readonly property int radiusControl: 8
    readonly property int radiusCard: 12
    readonly property int radiusPanel: radiusCard
    readonly property int radiusDialog: radiusCard
    readonly property int radius: radiusCard
    // Motion: reduced motion and quiet mode stop transitions; lower intensity shortens them and 0 stops them.
    readonly property bool reducedMotion: typeof App !== "undefined" && (App.state.settings?.reducedMotion === true || App.state.settings?.quiet === true)
    readonly property real motionScale: reducedMotion ? 0 : Math.max(0, Math.min(1, (typeof App !== "undefined" ? (App.state.settings?.motionIntensity ?? 0.7) : 0.7) / 0.7))
    readonly property int feedbackDuration: duration(120)
    readonly property int navigationDuration: duration(180)
    readonly property int easing: Easing.OutCubic
    function duration(ms) { return Math.round(ms * motionScale) }
}
