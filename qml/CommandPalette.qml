import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "SettingsCatalog.js" as SettingsCatalog

Popup {
    id:rootPalette
    objectName:"commandPalette"
    parent:Overlay.overlay
    anchors.centerIn:parent
    scale:Theme.interfaceScale
    width:Math.min(Theme.commandWidth,parent?(parent.width-2*Theme.space4)/scale:Theme.commandWidth)
    height:Math.min(Theme.commandHeight,parent?(parent.height-2*Theme.space4)/scale:Theme.commandHeight)
    modal:true;dim:true;focus:true;padding:Theme.space4;margins:Theme.space4
    closePolicy:Popup.CloseOnEscape|Popup.CloseOnPressOutside
    background:Rectangle { color:Theme.surface;radius:Theme.radiusDialog;border.color:Theme.borderStrong }
    Overlay.modal:Rectangle { color:Theme.overlayScrim }

    signal sessionRequested(string id)
    signal folderRequested(string id)
    signal settingsRequested(string category, string target)
    signal pageRequested(int page)
    signal desktopRequested(string query)
    signal workflowsRequested()

    property var apps:[]
    property var windows:[]
    property int appsRequest:-1
    property int windowsRequest:-1
    property int searchRequest:-1
    property string searchRequestQuery:""
    property var brokerEntries:[]
    property string error:""
    readonly property string query:search.text.trim().toLowerCase()
    readonly property var navigation:App.state.navigation||({favorites:[],recents:[]})
    readonly property var favorites:navigation.favorites||[]
    readonly property var recents:navigation.recents||[]
    readonly property var allEntries:visible ? buildEntries().concat(brokerEntries||[]) : []
    readonly property var results:rankedEntries()

    function buildEntries() {
        let entries=[
            {id:"page:chat",kind:"page",title:"Chat",detail:"Open the current conversation",page:0},
            {id:"page:sessions",kind:"page",title:"Sessions",detail:"Browse and organize conversations",page:1},
            {id:"page:desktop",kind:"page",title:"Desktop",detail:"Actions, apps, and windows",page:2},
            {id:"page:settings",kind:"page",title:"Settings",detail:"Configure PAL",page:3},
            {id:"page:projects",kind:"page",title:"Projects",detail:"Project folders, defaults and quick sessions",page:4},
            // Opens the recipe chooser only: choosing, previewing and sending stay separate, reviewed steps.
            // Workbench: opens a pane of the current conversation's Workbench; nothing runs from here.
            {id:"workbench:open",kind:"workbench",title:"Open Workbench",detail:"Files, previews, changes, images and runs for this conversation",search:"workbench files images runs",value:""},
            {id:"workbench:files",kind:"workbench",title:"Browse project files",detail:"Workbench › Files",search:"browse project files folder workspace",value:"files"},
            {id:"workbench:changes",kind:"workbench",title:"Review pending changes",detail:"Workbench › Changes",search:"review pending changes diff edits",value:"changes"},
            {id:"workbench:create",kind:"workbench",title:"Create image",detail:"Workbench › Images › Create",search:"create image generate picture draw",value:"create"},
            {id:"workbench:artifacts",kind:"workbench",title:"Show artifacts",detail:"Workbench › Images (all files)",search:"artifacts produced files outputs gallery",value:"images"},
            {id:"workbench:runs",kind:"workbench",title:"Show active runs",detail:"Workbench › Runs",search:"active runs jobs operations code lab",value:"runs"},
            {id:"workbench:notes",kind:"workbench",title:"Open Notes",detail:"Workbench › Notes",search:"notes notebook library scratchpad daybook",value:"notes"},
            {id:"workbench:canvas",kind:"workbench",title:"Open Canvas",detail:"Workbench › Canvas",search:"canvas preview",value:"canvas"},
            {id:"workbench:research",kind:"workbench",title:"Research a question",detail:"Workbench › Research · a cited report from sources PAL reads",search:"research sources cite report evidence web compare",value:"research"},
            {id:"workbench:terminal",kind:"workbench",title:"Open a terminal",detail:"Workbench › Terminal · Bash or Fish on this computer",search:"terminal shell bash fish zsh command line console pty",value:"terminal"},
            {id:"page:recipes",kind:"workflow",title:"Project recipes",detail:"Reviewed one-turn recipes: compare options, review a plan, prepare a handoff…",search:"project recipes workflows starters compare options review plan handoff explain subsystem diff crash release error"},
            {id:"workflow:routines",kind:"workflow",title:"Routines and schedules",detail:"Project workflows › scheduled and folder-triggered recipes",search:"routine routines schedule schedules scheduled folder trigger watched folder unattended missed run quiet period"}
        ]
        entries=entries.concat((App.state.sessions||[]).map(session=>({
            id:"session:"+session.id,kind:"session",title:session.title||"Untitled session",
            detail:(session.provider||"")+" · "+(session.cwd||""),search:(session.title||"")+" "+(session.cwd||"")+" "+(session.provider||""),value:session.id
        })))
        entries=entries.concat((App.state.folders||[]).map(folder=>({id:"folder:"+folder.id,kind:"folder",title:folder.name,detail:"Session folder",value:folder.id})))
        // Settings categories and the settings in them, from the same catalog as the Settings page.
        for(const category of SettingsCatalog.visibleCategories(App.state.speech===undefined?["voice"]:[],AvatarCatalog.entries)){
            entries.push({id:"settings:"+category.id,kind:"settings",title:category.label,detail:"Settings · "+category.blurb,search:category.label+" "+category.keywords,value:{category:category.id,target:""}})
            for(const setting of category.settings)entries.push({id:"settings:"+category.id+"/"+setting.target,kind:"settings",title:setting.label,detail:"Settings › "+category.label,search:setting.label+" "+setting.keywords,value:{category:category.id,target:setting.target}})
        }
        entries=entries.concat((App.state.actions||[]).map(action=>({
            id:"action:"+action.name,kind:"action",title:action.title||action.name,detail:action.description||action.category||"Desktop action",search:(action.title||"")+" "+(action.name||"")+" "+(action.description||"")
        })))
        entries=entries.concat(apps.map(app=>({id:"app:"+app.id,kind:"app",title:app.name,detail:"Application · review in Desktop",search:(app.name||"")+" "+(app.id||"")})))
        entries=entries.concat(windows.map(window=>({id:"window:"+window.address,kind:"window",title:window.title||window.class||"Untitled window",detail:(window.class||"Window")+" · review in Desktop",search:(window.title||"")+" "+(window.class||"")})))
        entries=entries.concat((App.state.settings?.scripts||[]).map(script=>({id:"script:"+script.id,kind:"script",title:script.name,detail:"Saved script · review before running",value:script})))
        return entries
    }
    function rankedEntries() {
        const seen={}
        let matches=allEntries.filter(entry=>{
            if(seen[entry.id])return false
            seen[entry.id]=true
            if(!query){const destination=destinationId(entry);return favorites.indexOf(destination)>=0||recents.indexOf(destination)>=0||entry.kind==="page"||entry.kind==="workflow"||entry.kind==="workbench"||entry.kind==="bookmark"}
            return (entry.search||entry.title+" "+entry.detail+" "+entry.kind).toLowerCase().indexOf(query)>=0
        })
        matches.sort((a,b)=>{
            const destinationA=destinationId(a),destinationB=destinationId(b)
            const favoriteA=favorites.indexOf(destinationA),favoriteB=favorites.indexOf(destinationB)
            if((favoriteA>=0)!==(favoriteB>=0))return favoriteA>=0?-1:1
            if(favoriteA>=0&&favoriteA!==favoriteB)return favoriteA-favoriteB
            const recentA=recents.indexOf(destinationA),recentB=recents.indexOf(destinationB)
            if((recentA>=0)!==(recentB>=0))return recentA>=0?-1:1
            if(recentA>=0&&recentA!==recentB)return recentA-recentB
            if(query){
                const titleA=a.title.toLowerCase(),titleB=b.title.toLowerCase()
                const exactA=titleA===query?0:titleA.startsWith(query)?1:2,exactB=titleB===query?0:titleB.startsWith(query)?1:2
                if(exactA!==exactB)return exactA-exactB
                const kinds={bookmark:0,capsule:1,transcript:2,settings:3,session:4,folder:5,project:6,page:7,workflow:7,action:8,app:9,window:10,script:11}
                const kindA=kinds[a.kind]===undefined?20:kinds[a.kind],kindB=kinds[b.kind]===undefined?20:kinds[b.kind]
                if(kindA!==kindB)return kindA-kindB
            }
            return a.title.localeCompare(b.title)
        })
        return matches.slice(0,80)
    }
    function destinationId(entry){return entry?.navigationId||entry?.id||""}
    function scheduleSearch(){brokerEntries=[];error="";searchDelay.restart()}
    function requestBrokerSearch(){
        searchDelay.stop()
        if(!App.connected){searchRequest=-1;return}
        searchRequestQuery=query
        searchRequest=App.rpc("navigation.search",{query:searchRequestQuery,tag:searchRequestQuery,limit:80})
    }
    function openPalette() {
        error="";search.text="";brokerEntries=[];open();refreshCatalog();requestBrokerSearch()
        Qt.callLater(()=>search.forceActiveFocus())
    }
    onClosed:searchDelay.stop()
    function refreshCatalog() {
        if(!App.connected)return
        if(appsRequest<0)appsRequest=App.rpc("apps.list")
        if(windowsRequest<0)windowsRequest=App.rpc("windows.list")
    }
    function activate(entry) {
        if(!entry)return
        App.rpc("navigation.record",{id:destinationId(entry)})
        if(entry.kind==="session")sessionRequested(entry.value)
        else if(entry.kind==="transcript"||entry.kind==="bookmark")sessionRequested(entry.sessionId||entry.value)
        else if(entry.kind==="project"||entry.kind==="capsule")App.rpc("action.run",{name:"files.open",args:{path:entry.cwd}})
        else if(entry.kind==="folder")folderRequested(entry.value)
        else if(entry.kind==="settings")settingsRequested(entry.value.category,entry.value.target)
        else if(entry.kind==="page")pageRequested(entry.page)
        else if(entry.kind==="workflow")workflowsRequested()
        else if(entry.kind==="workbench"){pageRequested(0);WorkbenchState.createRequested=entry.value==="create";WorkbenchState.show(entry.value==="create"?"images":entry.value)}
        else if(entry.kind==="script"){
            scriptReview.script=entry.value
            close();Qt.callLater(()=>scriptReview.open())
            return
        } else desktopRequested(entry.title)
        close()
    }
    function toggleFavorite(entry) {
        const id=destinationId(entry);App.rpc("navigation.favorite",{id:id,favorite:favorites.indexOf(id)<0})
    }

    Timer { id:searchDelay;interval:180;repeat:false;onTriggered:rootPalette.requestBrokerSearch() }
    function moveSelection(amount) {
        if(!results.length)return
        resultList.currentIndex=Math.max(0,Math.min(results.length-1,resultList.currentIndex+amount))
        resultList.positionViewAtIndex(resultList.currentIndex,ListView.Contain)
    }
    function focusResults(){
        if(!results.length)return false
        if(resultList.currentIndex<0)resultList.currentIndex=0
        resultList.positionViewAtIndex(resultList.currentIndex,ListView.Contain)
        resultList.forceActiveFocus(Qt.TabFocusReason)
        return true
    }
    contentItem:ColumnLayout {
        spacing:Theme.space2
        RowLayout {
            Layout.fillWidth:true
            CIcon { name:"search";Layout.preferredWidth:Theme.iconSize;Layout.preferredHeight:Theme.iconSize;color:Theme.accentText }
            CField {
                id:search;objectName:"commandPaletteSearch";Layout.fillWidth:true
                placeholderText:"Search sessions, folders, settings, or desktop…";Accessible.name:"Command palette search"
                onTextChanged:{resultList.currentIndex=rootPalette.results.length?0:-1;rootPalette.scheduleSearch()}
                onAccepted:if(resultList.currentIndex>=0)rootPalette.activate(rootPalette.results[resultList.currentIndex])
                Keys.onDownPressed:event=>{event.accepted=rootPalette.focusResults()}
                Keys.onUpPressed:event=>{rootPalette.moveSelection(-1);event.accepted=true}
            }
            CButton { text:"Close";quiet:true;onClicked:rootPalette.close() }
        }
        CText {
            text:rootPalette.query?rootPalette.results.length+" result"+(rootPalette.results.length===1?"":"s"):"Favorites, recent destinations, and shortcuts"
            color:Theme.muted;font.pixelSize:Theme.caption
        }
        ListView {
            id:resultList;objectName:"commandPaletteResults"
            Layout.fillWidth:true;Layout.fillHeight:true;clip:true;spacing:Theme.space1
            model:rootPalette.results;currentIndex:count?0:-1
            activeFocusOnTab:true;keyNavigationEnabled:true
            Accessible.role:Accessible.List;Accessible.name:"Command palette results"
            Accessible.description:"Use Up and Down to choose a destination, Enter to open it, or Right Arrow to favorite it."
            ScrollBar.vertical:CScrollBar{}
            Keys.onReturnPressed:event=>{if(currentIndex>=0)rootPalette.activate(rootPalette.results[currentIndex]);event.accepted=true}
            Keys.onEnterPressed:event=>{if(currentIndex>=0)rootPalette.activate(rootPalette.results[currentIndex]);event.accepted=true}
            Keys.onRightPressed:event=>{if(currentItem){currentItem.focusFavorite();event.accepted=true}}
            delegate:RowLayout {
                id:resultRow
                required property var modelData
                required property int index
                function focusFavorite(){favoriteButton.forceActiveFocus(Qt.TabFocusReason)}
                function moveFavorite(step){
                    resultList.currentIndex=Math.max(0,Math.min(resultList.count-1,index+step))
                    resultList.positionViewAtIndex(resultList.currentIndex,ListView.Contain)
                    Qt.callLater(()=>{if(resultList.currentItem)resultList.currentItem.focusFavorite()})
                }
                width:resultList.width-Theme.minimumTarget;spacing:Theme.space2
                CButton {
                    objectName:"command_"+resultRow.modelData.id.replace(/[^a-zA-Z0-9_-]/g,"_")
                    Layout.fillWidth:true;implicitHeight:Theme.rowDetailHeight;quiet:true;alignLeft:true
                    activeFocusOnTab:false;focusPolicy:Qt.NoFocus
                    text:resultRow.modelData.title
                    primary:resultList.currentIndex===resultRow.index
                    Accessible.selected:primary
                    help:resultRow.modelData.detail
                    Accessible.name:resultRow.modelData.title+", "+resultRow.modelData.detail
                    onClicked:{resultList.currentIndex=resultRow.index;rootPalette.activate(resultRow.modelData)}
                    contentItem:ColumnLayout {
                        spacing:Theme.space1
                        Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:resultRow.modelData.title;color:Theme.text;font.family:Theme.font;font.pixelSize:Theme.body;font.weight:Font.Medium;elide:Text.ElideRight;textFormat:Text.PlainText }
                        Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:resultRow.modelData.detail;color:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption;elide:Text.ElideMiddle;textFormat:Text.PlainText }
                    }
                }
                CButton {
                    id:favoriteButton
                    objectName:"favorite_"+resultRow.modelData.id.replace(/[^a-zA-Z0-9_-]/g,"_")
                    activeFocusOnTab:false
                    text:rootPalette.favorites.indexOf(rootPalette.destinationId(resultRow.modelData))>=0?"★":"☆";quiet:true
                    help:rootPalette.favorites.indexOf(rootPalette.destinationId(resultRow.modelData))>=0?"Remove from favorites":"Add to favorites"
                    Accessible.name:help
                    onClicked:rootPalette.toggleFavorite(resultRow.modelData)
                    Keys.onLeftPressed:event=>{resultList.forceActiveFocus(Qt.BacktabFocusReason);event.accepted=true}
                    Keys.onEscapePressed:event=>{resultList.forceActiveFocus(Qt.BacktabFocusReason);event.accepted=true}
                    Keys.onUpPressed:event=>{resultRow.moveFavorite(-1);event.accepted=true}
                    Keys.onDownPressed:event=>{resultRow.moveFavorite(1);event.accepted=true}
                }
            }
            CText { visible:resultList.count===0;width:parent.width;text:rootPalette.query?"No matching destination.":"Search to find anything in PAL.";color:Theme.muted;horizontalAlignment:Text.AlignHCenter }
        }
        CText { visible:rootPalette.error.length>0;text:rootPalette.error;color:Theme.danger;font.pixelSize:Theme.secondary }
        CText { text:"↑ ↓ navigate  ·  Enter open  ·  Esc close";color:Theme.muted;font.pixelSize:Theme.caption;horizontalAlignment:Text.AlignRight }
    }

    CDialog {
        id:scriptReview;objectName:"commandScriptReview";property var script:({});property int requestId:-1;property string error:""
        onOpened:error=""
        CText { text:"Run "+(scriptReview.script.name||"saved script")+"?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Executable";color:Theme.muted;font.pixelSize:Theme.caption }
        CText { text:scriptReview.script.executable||"";font.family:Theme.mono;font.pixelSize:Theme.secondary }
        CText { text:"Arguments";color:Theme.muted;font.pixelSize:Theme.caption }
        CText { text:JSON.stringify(scriptReview.script.args||[]);font.family:Theme.mono;font.pixelSize:Theme.secondary }
        CText { text:"Working folder";color:Theme.muted;font.pixelSize:Theme.caption }
        CText { text:scriptReview.script.cwd||"";font.family:Theme.mono;font.pixelSize:Theme.secondary }
        CText { visible:scriptReview.error.length>0;text:scriptReview.error;color:Theme.danger;font.pixelSize:Theme.secondary }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Cancel";enabled:scriptReview.requestId<0;onClicked:scriptReview.close() }
            CButton {
                objectName:"commandRunScript";Layout.fillWidth:true;text:scriptReview.requestId>=0?"Running…":"Run script";primary:true
                enabled:scriptReview.requestId<0&&App.connected
                onClicked:scriptReview.requestId=App.rpc("action.run",{name:"script.run",args:{id:scriptReview.script.id},expectedScript:scriptReview.script})
            }
        }
    }
    Connections {
        target:App
        function onResult(id,value) {
            if(id===rootPalette.appsRequest){rootPalette.appsRequest=-1;if(value?.error)rootPalette.error=value.error;else rootPalette.apps=value}
            if(id===rootPalette.windowsRequest){rootPalette.windowsRequest=-1;if(value?.error)rootPalette.error=value.error;else rootPalette.windows=value}
            if(id===rootPalette.searchRequest){
                const expectedQuery=rootPalette.searchRequestQuery
                rootPalette.searchRequest=-1
                if(expectedQuery===rootPalette.query){
                    if(value?.error)rootPalette.error=typeof value.error==="string"?value.error:value.error.message||"Search failed"
                    else if(value?.query===rootPalette.query&&value?.tag===expectedQuery){rootPalette.error="";rootPalette.brokerEntries=(value.entries||[]).map(entry=>Object.assign({broker:true},entry))}
                }
            }
            if(id===scriptReview.requestId){scriptReview.requestId=-1;if(value?.error)scriptReview.error=value.error;else{scriptReview.close();App.notify(value?.message||"Script finished")}}
        }
    }
}
