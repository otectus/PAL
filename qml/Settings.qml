pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "SettingsCatalog.js" as Catalog
// Settings, one category at a time. SettingsCatalog.js lists the categories and their settings for
// the rail or chips, the search and deep links. Each category loads on its first visit.
// Visited pages stay in the scroll view to preserve unsubmitted edits and pending requests.
ColumnLayout {
    id:settingsView
    objectName:"settingsPage"
    spacing:Theme.space3
    property string category:Catalog.lastCategory
    property string pendingTarget:""
    // A category is a reading surface. Keep each one's place while moving through Settings;
    // a direct search/deep link deliberately replaces the restored position below.
    property var categoryPositions:({})
    property string positionedCategory:""
    readonly property bool rail:width>=Theme.settingsBreakpoint
    // Derived from a bool so the arrays below change only when speech availability does.
    readonly property bool voiceAvailable:App.state.speech!==undefined
    readonly property var hiddenCategories:voiceAvailable?[]:["voice"]
    readonly property var current:Catalog.category(category)||Catalog.category(Catalog.defaultCategory)
    readonly property string query:settingsSearch.text.trim()
    readonly property var results:Catalog.search(query,hiddenCategories,AvatarCatalog.entries)
    readonly property var pages:({companion:companionPage,personality:personalityPage,voice:voicePage,motion:motionPage,connections:connectionsPage,knowledge:knowledgePage,assistance:assistancePage,scripts:scriptsPage,skills:skillsPage,setups:setupsPage,usage:usagePage,mobile:mobilePage,telemetry:telemetryPage,application:applicationPage})
    component CategoryPage: LazyPage {
        required property string key
        Layout.fillWidth: true
        selected: settingsView.category === key
        visible: selected
        onLoaded: if (selected) settingsView.restoreCategoryPosition()
    }
    function rememberCategoryPosition(){
        if(!positionedCategory)return
        const next=Object.assign({},categoryPositions)
        next[positionedCategory]=settingsScroll.contentY
        categoryPositions=next
    }
    function restoreCategoryPosition(){
        const id=category
        const position=Math.max(0,categoryPositions[id]||0)
        Qt.callLater(()=>{
            if(settingsView.category!==id||settingsView.pendingTarget)return
            settingsScroll.contentY=Math.min(Math.max(0,settingsScroll.contentHeight-settingsScroll.height),position)
        })
    }
    onCategoryChanged:{
        if(positionedCategory!==category){rememberCategoryPosition();positionedCategory=category}
        Catalog.remember(category)
        if(!pendingTarget)restoreCategoryPosition()
    }
    // A remembered category can be unavailable when this page is made (Voice before speech is ready).
    onHiddenCategoriesChanged:if(hiddenCategories.indexOf(category)>=0)category=Catalog.defaultCategory
    Component.onCompleted:{
        if(hiddenCategories.indexOf(category)>=0)category=Catalog.defaultCategory
        positionedCategory=category
    }
    function focusSearch(){settingsSearch.forceActiveFocus()}
    function focusResult(index){
        if(index<0||index>=resultList.count)return
        resultList.currentIndex=index;resultList.positionViewAtIndex(index,ListView.Contain)
        Qt.callLater(()=>{const item=resultList.itemAtIndex(index);if(item)item.forceActiveFocus(Qt.TabFocusReason)})
    }
    Shortcut { sequences:[StandardKey.Find];enabled:settingsView.visible;onActivated:settingsView.focusSearch() }
    // Opens a category; with a target, the control with that objectName instead.
    function open(id,target){
        settingsSearch.text=""
        if(target&&revealInCategory(target,id))return
        if(Catalog.category(id)&&hiddenCategories.indexOf(id)<0)category=id
    }
    function openResult(result){if(result)open(result.category.id,result.setting?result.setting.target:"")}
    // Shows the category holding a control, scrolls to it and focuses it; a brief outline marks it.
    // A control in a part of the page that is switched off reveals that part instead.
    function revealControl(name) { return revealInCategory(name, "") }
    function revealInCategory(name,preferred){
        let id=Catalog.categoryOf(name)
        if (!id && preferred && pages[preferred] && find(pages[preferred].ensure(), name)) id = preferred
        if (!id) for (const key in pages) if (find(pages[key].item, name)) { id = key; break }
        // Some integrations deep-link by object name without a catalog entry.
        if (!id) for (const key in pages) if (find(pages[key].ensure(), name)) { id = key; break }
        if(!id||hiddenCategories.indexOf(id)>=0)return false
        settingsSearch.text=""
        pendingTarget=name;category=id
        Qt.callLater(finishReveal)
        return true
    }
    function find(item,name){
        if(!item)return null
        if(item.objectName===name)return item
        for(let index=0;index<item.children.length;++index){const match=find(item.children[index],name);if(match)return match}
        return null
    }
    // Lays the visible pages out now rather than at the next frame. The page was hidden a moment ago, and
    // wrapped text learns its height only once it has its width, so passes repeat until the item holds still.
    function settle(item){
        const polish=node=>{if(!node.visible)return;node.ensurePolished();for(let index=0;index<node.children.length;++index)polish(node.children[index])}
        let top=NaN
        for(let pass=0;pass<4;++pass){
            polish(settingsScroll.contentItem)
            const y=item.mapToItem(settingsScroll.contentItem,0,0).y
            if(y===top)break
            top=y
        }
        return top
    }
    function finishReveal(){
        const page=pages[category].ensure(),target=find(page,pendingTarget);pendingTarget=""
        for (let ancestor=target; ancestor; ancestor=ancestor.parent) {
            if (typeof ancestor.revealSection === "function") ancestor.revealSection()
            if (ancestor===page) break
        }
        let shown=target;while(shown&&shown!==page&&!shown.visible)shown=shown.parent
        if(!shown)return
        if(shown===target&&target.enabled&&target.activeFocusOnTab)target.forceActiveFocus(Qt.OtherFocusReason)
        const top=settle(shown)
        settingsScroll.contentY=Math.max(0,Math.min(settingsScroll.contentHeight-settingsScroll.height,top-Math.min(96,settingsScroll.height/4)))
        spotlight.show(shown)
    }
    ColumnLayout {
        Layout.fillWidth:true;spacing:Theme.space1
        CText { text:"Settings";font.pixelSize:Theme.page;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading }
    }
    CField {
        id:settingsSearch;objectName:"settingsSearch";Layout.fillWidth:true
        leftPadding:Theme.fieldActionInset;placeholderText:"Find a setting…";Accessible.name:"Find a setting"
        CIcon { name:"search";x: Theme.space3;anchors.verticalCenter:parent.verticalCenter;color:settingsSearch.activeFocus?Theme.accentText:Theme.muted }
        onAccepted:settingsView.openResult(settingsView.results[0])
        // Escape clears a search first; on an empty field it leaves Settings as before.
        Keys.onEscapePressed:event=>{if(text.length){clear();event.accepted=true}else event.accepted=false}
        Keys.onDownPressed:event=>{event.accepted=resultList.count>0;if(event.accepted)settingsView.focusResult(0)}
    }
    SettingsNav {
        visible:!settingsView.rail&&!settingsView.query
        rail:false;Layout.fillWidth:true;Layout.preferredHeight:implicitHeight
        category:settingsView.category;hidden:settingsView.hiddenCategories
        onSelected:id=>settingsView.open(id,"")
    }
    RowLayout {
        Layout.fillWidth:true;Layout.fillHeight:true;spacing:Theme.space3
        SettingsNav {
            visible:settingsView.rail
            id:settingsRail
            Layout.minimumHeight:0
            rail:true;Layout.preferredWidth:Math.max(Theme.settingsRailMinimum,Math.min(settingsView.width * .35,WorkbenchState.layout.settingsNavWidth));Layout.fillHeight:true
            category:settingsView.category;hidden:settingsView.hiddenCategories
            onSelected:id=>settingsView.open(id,"")
        }
        PaneGrip {
            objectName: "settingsNavResize"; visible: settingsView.rail
            Layout.fillHeight: true
            coordinateSpace: settingsView; label: qsTr("Resize settings navigation"); extent: settingsRail.width
            minimum: Theme.settingsRailMinimum; maximum: Math.min(Theme.narrowPane, settingsView.width * .35)
            onResized: size => WorkbenchState.layout.settingsNavWidth = size
            onResetRequested: WorkbenchState.layout.settingsNavWidth = Theme.settingsRailWidth
        }
        ColumnLayout {
            Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0;spacing:Theme.space2
            ColumnLayout {
                visible:settingsView.query.length>0
                Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0;spacing:Theme.space2
                CText {
                    objectName:"settingsResultSummary";color:Theme.muted;font.pixelSize:Theme.caption
                    text:settingsView.results.length?settingsView.results.length+(settingsView.results.length===1?" match":" matches")+" for “"+settingsView.query+"” · Enter opens the first":"Nothing by that name. Try a broader word, like voice or memory."
                }
                ListView {
                    id:resultList;objectName:"settingsResults"
                    Layout.fillWidth:true;Layout.fillHeight:true;clip:true;spacing:Theme.space1
                    model:settingsView.results
                    Accessible.role:Accessible.List;Accessible.name:"Matching settings"
                    ScrollBar.vertical:CScrollBar {}
                    delegate:CButton {
                        id:result
                        required property var modelData
                        required property int index
                        readonly property string detail:modelData.setting?Catalog.group(modelData.category.group).label+" › "+modelData.category.label:"Category · "+modelData.category.blurb
                        objectName:"settingsResult_"+index
                        width:resultList.width-Theme.minimumTarget;implicitHeight:Theme.rowDetailHeight;quiet:true;alignLeft:true
                        text:modelData.setting?modelData.setting.label:modelData.category.label
                        help:detail;Accessible.name:text+", "+detail
                        onClicked:settingsView.openResult(modelData)
                        contentItem:ColumnLayout {
                            spacing:Theme.space1
                            Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:result.text;color:Theme.text;font.family:Theme.font;font.pixelSize:Theme.body;font.weight:Font.Medium;elide:Text.ElideRight;textFormat:Text.PlainText }
                            Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:result.detail;color:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption;elide:Text.ElideRight;textFormat:Text.PlainText }
                        }
                        Keys.onUpPressed:event=>{if(index>0)settingsView.focusResult(index-1);else settingsSearch.forceActiveFocus();event.accepted=true}
                        Keys.onDownPressed:event=>{settingsView.focusResult(index+1);event.accepted=true}
                        Keys.onEscapePressed:event=>{settingsSearch.clear();settingsSearch.forceActiveFocus();event.accepted=true}
                    }
                }
            }
            PageScroll {
                id:settingsScroll;objectName:"settingsScroll"
                visible:!settingsView.query
                Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0;maximumContentWidth:Theme.settingsWidth
                ColumnLayout {
                    Layout.fillWidth:true;spacing:Theme.space1
                    // The rail already names the group beside a wide page.
                    SectionLabel { visible:!settingsView.rail;text:(Catalog.group(settingsView.current.group)||{label:""}).label.toUpperCase() }
                    CText { objectName:"settingsCategoryTitle";text:settingsView.current.label;font.pixelSize:Theme.title;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading }
                    CText { text:settingsView.current.blurb;color:Theme.muted;font.pixelSize:Theme.secondary }
                }
                CategoryPage { id: companionPage; key: "companion"; pageSource: "CompanionSettings.qml" }
                CategoryPage { id: personalityPage; key: "personality"; pageSource: "PersonalitySettings.qml" }
                CategoryPage { id: voicePage; key: "voice"; pageSource: "VoiceSettings.qml" }
                CategoryPage { id: motionPage; key: "motion"; pageSource: "MotionSettings.qml" }
                CategoryPage { id: connectionsPage; key: "connections"; pageSource: "ConnectionsSettings.qml" }
                CategoryPage { id: knowledgePage; key: "knowledge"; pageSource: "KnowledgeSettings.qml" }
                CategoryPage { id: assistancePage; key: "assistance"; pageSource: "AssistanceSettings.qml" }
                CategoryPage { id: scriptsPage; key: "scripts"; pageSource: "ScriptsSettings.qml" }
                CategoryPage { id: usagePage; key: "usage"; pageSource: "UsageSettings.qml" }
                CategoryPage { id: setupsPage; key: "setups"; pageSource: "SetupsSettings.qml" }
                CategoryPage { id: skillsPage; key: "skills"; pageSource: "SkillsSettings.qml" }
                CategoryPage { id: mobilePage; key: "mobile"; pageSource: "RemoteSettings.qml" }
                CategoryPage { id: telemetryPage; key: "telemetry"; pageSource: "TelemetrySettings.qml"; initialProperties: ({backend: App}) }
                CategoryPage { id: applicationPage; key: "application"; pageSource: "ApplicationSettings.qml" }
            }
            // Companion owns the avatar draft and request state; Settings keeps its commit action
            // stationary below the scrolling category so a long catalog never separates choice from save.
            Loader {
                id:avatarActionFooter
                objectName:"avatarActionFooter"
                visible:!settingsView.query&&settingsView.category==="companion"&&!!companionPage.item
                active:visible
                Layout.fillWidth:true
                Layout.preferredHeight:item?item.implicitHeight:0
                sourceComponent:companionPage.item?companionPage.item.avatarActions:null
            }
        }
    }
    // A brief outline around whatever revealControl() brought into view.
    Rectangle {
        id:spotlight;objectName:"settingsSpotlight"
        parent:settingsScroll.contentItem
        z:2;opacity:0;visible:opacity>0
        color:Theme.transparent;radius:Theme.radiusCard;border.color:Theme.accentText;border.width:Theme.focusWidth
        function show(item){
            const point=item.mapToItem(parent,0,0)
            x=point.x-6;y=point.y-6;width=item.width+Theme.space3;height=item.height+Theme.space3
            pulse.restart()
        }
        SequentialAnimation {
            id:pulse
            NumberAnimation { target:spotlight;property:"opacity";to:1;duration:Theme.feedbackDuration }
            PauseAnimation { duration:Theme.revealHold }
            NumberAnimation { target:spotlight;property:"opacity";to:0;duration:Theme.navigationDuration }
        }
    }
}
