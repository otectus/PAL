import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CSection {
    id:voiceSettings
    title:"Voice"
    description:"Read replies aloud using a local voice or ElevenLabs. Pinned conversations also speak each conversational update in the background and show it beside "+App.assistantName+". Quiet mode pauses automatic speech."
    property var settings:App.state.settings||({})
    property var speech:App.state.speech||({})
    property var transcriptionSettings:settings.transcription||({})
    property var voices:[]
    property var connections:[]
    RpcClient { id:connectionRpc }
    property int voicesRequest:-1
    property int hostedVoicesRequest:-1
    property var hostedVoices:[]
    property string error:""
    property bool loaded:false
    property var tuningRequests:({})
    readonly property bool savingTuning:Object.keys(tuningRequests).length>0
    readonly property bool available: App.state.speech !== undefined
    visible: available
    function refresh(){if(!available)return;loaded=true;voicesRequest=App.rpc("tts.voices",{})}
    function refreshHosted(){
        if(!["google_cloud","azure_speech"].includes(ttsProvider.currentValue))return
        hostedVoices=[];hostedVoicesRequest=App.rpc("voice.hostedVoices",{provider:ttsProvider.currentValue,settings:{model:hostedVoiceModel.text.trim(),voice:hostedVoiceName.text.trim(),language:hostedVoiceLanguage.text.trim(),region:hostedVoiceRegion.text.trim(),connectionId:hostedVoiceConnection.currentValue||""}})
    }
    function saveTuning(patch){
        error=""
        const id=App.rpc("settings.update",patch)
        if(id<0){error="Reconnect before changing voice settings.";return}
        const pending=Object.assign({},tuningRequests);pending[id]=true;tuningRequests=pending
    }
    component TuningSlider:ColumnLayout {
        id:tuning
        required property string settingKey
        required property string label
        property real minimum:0
        property real maximum:1
        property real increment:.05
        property real neutral:1
        property real displayScale:1
        property int decimals:2
        property string suffix:""
        property bool signed:false
        Layout.fillWidth:true;spacing:Theme.space1
        function saveValue(value){const patch={};patch[settingKey]=Math.round(value*100)/100;voiceSettings.saveTuning(patch)}
        function save(){saveValue(control.value)}
        RowLayout {
            Layout.fillWidth:true
            CText { text:tuning.label;font.pixelSize:Theme.secondary }
            CText {
                Layout.fillWidth:false
                text:(tuning.signed&&control.value>0?"+":"")+(control.value*tuning.displayScale).toFixed(tuning.decimals)+tuning.suffix
                color:Theme.accentText;font.pixelSize:Theme.secondary
            }
        }
        CSlider {
            id:control;objectName:tuning.settingKey;Layout.fillWidth:true;Layout.minimumWidth:0
            from:tuning.minimum;to:tuning.maximum;stepSize:tuning.increment
            snapMode:Slider.SnapAlways
            value:voiceSettings.settings[tuning.settingKey]===undefined?tuning.neutral:voiceSettings.settings[tuning.settingKey]
            Accessible.name:tuning.label
            // Persist once when a pointer drag ends; keyboard adjustments save immediately.
            onMoved:if(!pressed)tuning.save()
            onPressedChanged:if(!pressed)tuning.save()
            Keys.onPressed:event=>{
                if(event.key===Qt.Key_Home||event.key===Qt.Key_End){
                    tuning.saveValue(event.key===Qt.Key_Home?from:to);event.accepted=true
                }else event.accepted=false
            }
        }
    }
    Component.onCompleted:{if(App.connected&&available)refresh();loadDevices();connectionRpc.call("connections.list",{},value=>{if(!value.error)voiceSettings.connections=value})}
    CCheckBox {
        objectName:"speechEnabled";text:"Read replies aloud";checked:voiceSettings.settings.speechEnabled===true
        onClicked:App.rpc("settings.update",{speechEnabled:checked})
    }
    CText { text:"Speak replies from";font.weight:Font.DemiBold }
    CText { text:"Choose conversation providers for automatic speech, including pinned conversations. Turning one off stops its current and queued speech; message bubbles remain visible. Test voice still works.";font.pixelSize:Theme.secondary;color:Theme.muted }
    Flow {
        Layout.fillWidth:true;spacing:Theme.space2
        Repeater {
            model:(App.state.providerOrder||[]).map(id=>({id:id,name:(App.state.providerTraits||{})[id]?.label||id}))
            delegate:CCheckBox {
                required property var modelData
                objectName:"speechProvider_"+modelData.id;text:modelData.name
                checked:voiceSettings.settings.speechProviders?.[modelData.id]!==false
                onClicked:{const patch={};patch[modelData.id]=checked;App.rpc("settings.update",{speechProviders:patch})}
            }
        }
    }
    CComboBox {
        id:ttsProvider;objectName:"ttsProvider";Layout.fillWidth:true
        model:[{id:"local",label:"Local voices · Piper / Kokoro"},{id:"indextts",label:"IndexTTS · voice cloning"},{id:"elevenlabs",label:"ElevenLabs · API"},{id:"openai",label:"OpenAI speech"},{id:"xai",label:"Grok (xAI) speech"},{id:"google",label:"Google Gemini speech"},{id:"google_cloud",label:"Google Cloud Speech · ADC"},{id:"azure_speech",label:"Azure Speech"},{id:"azure_openai",label:"Azure OpenAI speech"},{id:"mistral",label:"Mistral speech"},{id:"openrouter",label:"OpenRouter speech"}];textRole:"label";valueRole:"id"
        currentIndex:Math.max(0,model.findIndex(row=>row.id===(voiceSettings.settings.ttsProvider||"local")))
        Accessible.name:"Speech provider"
        onActivated:App.rpc("settings.update",{ttsProvider:currentValue})
    }
    Loader { Layout.fillWidth:true;active:voiceSettings.settings.ttsProvider==="indextts";visible:active;source:"IndexTTSSettings.qml" }
    Loader { Layout.fillWidth:true;active:voiceSettings.settings.ttsProvider==="elevenlabs";visible:active;source:"ElevenLabsSettings.qml" }
    ColumnLayout {
        readonly property bool hosted:["openai","xai","google","google_cloud","azure_speech","azure_openai","mistral","openrouter"].includes(ttsProvider.currentValue)
        visible:hosted;Layout.fillWidth:true;spacing:Theme.space2
        CField { id:hostedVoiceModel;Layout.fillWidth:true;placeholderText:"Speech model";text:voiceSettings.settings.hostedVoice?.model||"";Accessible.name:"Hosted speech model" }
        CField { id:hostedVoiceName;Layout.fillWidth:true;placeholderText:"Voice";text:voiceSettings.settings.hostedVoice?.voice||"";Accessible.name:"Hosted voice" }
        CComboBox { visible:voiceSettings.hostedVoices.length>0;Layout.fillWidth:true;model:voiceSettings.hostedVoices;textRole:"label";valueRole:"id";currentIndex:Math.max(0,model.findIndex(row=>row.id===hostedVoiceName.text));Accessible.name:"Hosted voice catalog";onActivated:hostedVoiceName.text=currentValue }
        CField { id:hostedVoiceLanguage;Layout.fillWidth:true;placeholderText:"Language (optional)";text:voiceSettings.settings.hostedVoice?.language||"";Accessible.name:"Hosted voice language" }
        CField { id:hostedVoiceRegion;visible:ttsProvider.currentValue==="azure_speech";Layout.fillWidth:true;placeholderText:"Azure region";text:voiceSettings.settings.hostedVoice?.region||"";Accessible.name:"Azure Speech region" }
        CText { visible:ttsProvider.currentValue==="google";text:"Optional Gemini two-speaker dialogue";font.weight:Font.DemiBold }
        RowLayout { visible:ttsProvider.currentValue==="google";Layout.fillWidth:true
            CField { id:speakerOne;Layout.fillWidth:true;placeholderText:"Speaker 1 name";text:voiceSettings.settings.hostedVoice?.speakers?.[0]?.speaker||"" }
            CField { id:speakerOneVoice;Layout.fillWidth:true;placeholderText:"Speaker 1 voice";text:voiceSettings.settings.hostedVoice?.speakers?.[0]?.voice||"" }
        }
        RowLayout { visible:ttsProvider.currentValue==="google";Layout.fillWidth:true
            CField { id:speakerTwo;Layout.fillWidth:true;placeholderText:"Speaker 2 name";text:voiceSettings.settings.hostedVoice?.speakers?.[1]?.speaker||"" }
            CField { id:speakerTwoVoice;Layout.fillWidth:true;placeholderText:"Speaker 2 voice";text:voiceSettings.settings.hostedVoice?.speakers?.[1]?.voice||"" }
        }
        CComboBox { id:hostedVoiceConnection;visible:voiceSettings.connections.some(row=>row.kind===ttsProvider.currentValue);Layout.fillWidth:true;readonly property var choices:[{id:"",name:"Default account"}].concat(voiceSettings.connections.filter(row=>row.kind===ttsProvider.currentValue));model:choices;textRole:"name";valueRole:"id";currentIndex:Math.max(0,choices.findIndex(row=>row.id===(voiceSettings.settings.hostedVoice?.connectionId||"")));Accessible.name:"Hosted speech account" }
        CText { visible:ttsProvider.currentValue==="azure_openai"&&!hostedVoiceConnection.currentValue;text:"Choose a named Azure deployment account.";color:Theme.amber;font.pixelSize:Theme.caption }
        CButton { text:"Save hosted voice";enabled:ttsProvider.currentValue!=="azure_openai"||!!hostedVoiceConnection.currentValue;onClicked:{const value={model:hostedVoiceModel.text.trim(),voice:hostedVoiceName.text.trim(),language:hostedVoiceLanguage.text.trim(),region:hostedVoiceRegion.text.trim(),connectionId:hostedVoiceConnection.currentValue||""};if(ttsProvider.currentValue==="google"&&speakerOne.text.trim()&&speakerOneVoice.text.trim()&&speakerTwo.text.trim()&&speakerTwoVoice.text.trim())value.speakers=[{speaker:speakerOne.text.trim(),voice:speakerOneVoice.text.trim()},{speaker:speakerTwo.text.trim(),voice:speakerTwoVoice.text.trim()}];App.rpc("settings.update",{hostedVoice:value})} }
        CButton { visible:["google_cloud","azure_speech"].includes(ttsProvider.currentValue);text:voiceSettings.hostedVoicesRequest>=0?"Loading voices…":"Browse provider voices";enabled:voiceSettings.hostedVoicesRequest<0;onClicked:voiceSettings.refreshHosted() }
        CText { text:"Audio is sent to the selected provider account and may be billed.";color:Theme.muted;font.pixelSize:Theme.caption }
    }
    CComboBox {
        visible:!voiceSettings.settings.ttsProvider||voiceSettings.settings.ttsProvider==="local"
        objectName:"speechVoice";Layout.fillWidth:true;Layout.minimumWidth:0
        model:voiceSettings.voices;textRole:"label"
        Accessible.name:App.assistantName+" speaking voice"
        currentIndex:voiceSettings.voices.findIndex(v=>v.id===voiceSettings.settings.voice)
        displayText:(voiceSettings.voices.find(voice=>voice.id===voiceSettings.settings.voice)||{}).label||voiceSettings.settings.voice||"en_US-amy-medium"
        onActivated:App.rpc("settings.update",{voice:voiceSettings.voices[currentIndex].id})
    }
    TuningSlider { visible:voiceSettings.settings.ttsProvider!=="indextts";settingKey:"speechRate";label:"Speaking speed";minimum:.5;maximum:2;suffix:"×" }
    TuningSlider { settingKey:"speechPitch";label:"Pitch · lower / higher";minimum:-6;maximum:6;increment:.5;neutral:0;decimals:1;suffix:" semitones";signed:true }
    TuningSlider { settingKey:"speechVolume";label:App.assistantName+"’s volume";displayScale:100;decimals:0;suffix:"%" }
    CText { text:"Pitch changes tone without changing speed. Adjustments apply to new replies and Test voice. Volume affects speech only; 0% mutes the voice.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CButton {
        objectName:"resetVoiceTuning";text:"Reset voice adjustments";enabled:!voiceSettings.savingTuning
        onClicked:voiceSettings.saveTuning({speechRate:1,speechPitch:0,speechVolume:1})
    }
    CCheckBox { objectName:"speechBrief";text:"Read a brief opening instead of the full response";checked:voiceSettings.settings.speechBrief===true;onClicked:App.rpc("settings.update",{speechBrief:checked}) }
    GridLayout {
        Layout.fillWidth:true;columns:width>=Theme.compactPane?3:1;columnSpacing:Theme.space2;rowSpacing:Theme.space2
        CButton { objectName:"ttsTest";text:"Test voice";Layout.fillWidth:true;enabled:!voiceSettings.savingTuning;onClicked:App.rpc("tts.test",{}) }
        CButton { objectName:"ttsStop";text:"Stop speaking";Layout.fillWidth:true;onClicked:App.rpc("tts.stop",{}) }
        CButton { text:"Refresh voices";Layout.fillWidth:true;onClicked:voiceSettings.refresh() }
    }
    CText {
        objectName:"ttsStatus";font.pixelSize:Theme.secondary
        text:voiceSettings.speech.error||voiceSettings.error||(voiceSettings.settings.speechVolume===0?"Voice muted · raise the volume to preview":voiceSettings.speech.state==="preparing"?"Preparing voice…":voiceSettings.speech.state==="speaking"?"Speaking · "+voiceSettings.speech.backend:voiceSettings.speech.backend?"Ready · "+voiceSettings.speech.backend:"Ready to test")
        color:voiceSettings.speech.error||voiceSettings.error?Theme.danger:Theme.accentText
    }
    SpeechCacheSettings { Layout.fillWidth:true }
    CText { visible:!voiceSettings.settings.ttsProvider||voiceSettings.settings.ttsProvider==="local";text:"Add a voice’s .onnx and .onnx.json files to ~/.local/share/piper/voices/ or PAL’s config/voices/ folder, then refresh. Test voice plays even in quiet mode.";color:Theme.muted;font.pixelSize:Theme.secondary }
    Rectangle { Layout.fillWidth:true;implicitHeight:Theme.hairline;color:Theme.line }
    CText { text:"Voice input";font.weight:Font.DemiBold }
    CComboBox { id:transcriptionProvider;objectName:"transcriptionProvider";readonly property bool hosted:!["local","local-server"].includes(currentValue);Layout.fillWidth:true;model:[{id:"local",label:"Local · whisper.cpp"},{id:"local-server",label:"Local · speech server"},{id:"openai",label:"OpenAI"},{id:"xai",label:"Grok (xAI)"},{id:"google",label:"Google"},{id:"google_cloud",label:"Google Cloud Speech · ADC"},{id:"azure_speech",label:"Azure Speech"},{id:"azure_openai",label:"Azure OpenAI"},{id:"mistral",label:"Mistral"},{id:"openrouter",label:"OpenRouter"}];textRole:"label";valueRole:"id";currentIndex:Math.max(0,model.findIndex(row=>row.id===(voiceSettings.transcriptionSettings.provider||"local")));Accessible.name:"Transcription provider";onActivated:App.rpc("settings.update",{transcription:{provider:currentValue}}) }
    CText { text:transcriptionProvider.currentValue==="local"?"Push-to-talk uses whisper.cpp already installed on this computer. PAL never uploads recordings.":transcriptionProvider.currentValue==="local-server"?"Push-to-talk asks a speech server on this computer, which keeps its model loaded between recordings. PAL never uploads recordings.":"Push-to-talk sends audio to the selected provider account and may be billed.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    CField {
        id:whisperExecutable;objectName:"whisperExecutable";visible:transcriptionProvider.currentValue==="local";Layout.fillWidth:true
        placeholderText:"Absolute path to whisper-cli";text:voiceSettings.transcriptionSettings.executable||""
        Accessible.name:"whisper.cpp executable path"
    }
    CField {
        id:whisperModel;objectName:"whisperModel";visible:transcriptionProvider.currentValue==="local";Layout.fillWidth:true
        placeholderText:"Absolute path to a local GGML model";text:voiceSettings.transcriptionSettings.model||""
        Accessible.name:"whisper.cpp model path"
    }
    CButton {
        objectName:"saveTranscription";visible:transcriptionProvider.currentValue==="local";text:"Save local voice-input paths"
        enabled:whisperExecutable.text.trim().startsWith("/")&&whisperModel.text.trim().startsWith("/")
        onClicked:App.rpc("settings.update",{transcription:{executable:whisperExecutable.text.trim(),model:whisperModel.text.trim()}})
    }
    CField { id:cloudTranscriptionModel;visible:transcriptionProvider.hosted;Layout.fillWidth:true;placeholderText:"Transcription model";text:voiceSettings.transcriptionSettings.cloudModel||"";Accessible.name:"Cloud transcription model" }
    CField { id:cloudTranscriptionLanguage;visible:transcriptionProvider.hosted;Layout.fillWidth:true;placeholderText:"Language (optional)";text:voiceSettings.transcriptionSettings.language||"";Accessible.name:"Transcription language" }
    CField { id:cloudTranscriptionRegion;visible:transcriptionProvider.currentValue==="azure_speech";Layout.fillWidth:true;placeholderText:"Azure region";text:voiceSettings.transcriptionSettings.region||"";Accessible.name:"Azure transcription region" }
    CComboBox { id:cloudTranscriptionConnection;visible:transcriptionProvider.hosted&&voiceSettings.connections.some(row=>row.kind===transcriptionProvider.currentValue);Layout.fillWidth:true;readonly property var choices:[{id:"",name:"Default account"}].concat(voiceSettings.connections.filter(row=>row.kind===transcriptionProvider.currentValue));model:choices;textRole:"name";valueRole:"id";currentIndex:Math.max(0,choices.findIndex(row=>row.id===(voiceSettings.transcriptionSettings.connectionId||"")));Accessible.name:"Transcription account" }
    CText { visible:transcriptionProvider.currentValue==="azure_openai"&&!cloudTranscriptionConnection.currentValue;text:"Choose a named Azure deployment account.";color:Theme.amber;font.pixelSize:Theme.caption }
    CButton { visible:transcriptionProvider.hosted;text:"Save cloud transcription";enabled:transcriptionProvider.currentValue!=="azure_openai"||!!cloudTranscriptionConnection.currentValue;onClicked:App.rpc("settings.update",{transcription:{provider:transcriptionProvider.currentValue,cloudModel:cloudTranscriptionModel.text.trim(),language:cloudTranscriptionLanguage.text.trim(),region:cloudTranscriptionRegion.text.trim(),connectionId:cloudTranscriptionConnection.currentValue||""}}) }
    SpeechServerSettings { visible:transcriptionProvider.currentValue==="local-server";Layout.fillWidth:true;saved:voiceSettings.transcriptionSettings }
    CText { visible:transcriptionProvider.currentValue!=="local-server";text:"Follow the whisper.cpp README at github.com/ggml-org/whisper.cpp: build whisper-cli locally and download a GGML model with the project’s model script. Paste both absolute paths above. Audio capture uses PipeWire pw-record, with ALSA arecord as a fallback. Recordings are limited to 60 seconds and deleted after finish, cancel, or error.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    // M21: spoken commands from a fixed list; the transcript stays ordinary text unless it is one of them.
    CText { text:"Voice commands";font.weight:Font.DemiBold }
    CCheckBox { objectName:"voiceCommandsEnabled";text:"Recognize spoken commands";checked:voiceSettings.settings.voiceCommands?.enabled===true;onClicked:App.rpc("settings.update",{voiceCommands:{enabled:checked}}) }
    CCheckBox { objectName:"voiceCommandsConfirm";visible:voiceSettings.settings.voiceCommands?.enabled===true;text:"Show a command before running it";checked:voiceSettings.settings.voiceCommands?.confirm!==false;onClicked:App.rpc("settings.update",{voiceCommands:{confirm:checked}}) }
    CCheckBox { objectName:"voiceCommandsSpeak";visible:voiceSettings.settings.voiceCommands?.enabled===true;text:"Say navigation commands aloud";checked:voiceSettings.settings.voiceCommands?.speakFeedback===true;onClicked:App.rpc("settings.update",{voiceCommands:{speakFeedback:checked}}) }
    CText { text:"Say only the command, optionally starting with "+App.assistantName+": “stop speaking”, “read that again”, “stop the reply”, “open settings”, “show conversations”, “open desktop” or “new conversation”. Anything else stays text for your draft. Commands never answer a permission question; the Stop button always works.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    // M10: which microphone records and which speaker plays. A chosen device that is unplugged is
    // reported instead of quietly using another one.
    CText { text:"Audio devices";font.weight:Font.DemiBold }
    property var audioDevices:({backend:"",inputs:[],outputs:[]})
    property int devicesRequest:-1
    property string devicesError:""
    function loadDevices(){devicesError="";devicesRequest=App.rpc("audio.devices",{})}
    function deviceChoices(list,chosen){
        const items=[{id:"",label:"System default"}].concat(list.map(device=>({id:device.id,label:device.label+(device.isDefault?" · current default":"")})))
        return chosen&&!list.some(device=>device.id===chosen)?items.concat([{id:chosen,label:chosen.replace(/^(pw|alsa):/,"")+" · not connected"}]):items
    }
    readonly property var audioChoice:settings.audio||({input:"",output:""})
    readonly property var inputChoices:deviceChoices(audioDevices.inputs||[],audioChoice.input)
    readonly property var outputChoices:deviceChoices(audioDevices.outputs||[],audioChoice.output)
    GridLayout {
        Layout.fillWidth:true;columns:width>=Theme.toolbarBreakpoint?2:1;columnSpacing:Theme.space2;rowSpacing:Theme.space2
        CText { text:"Microphone";color:Theme.muted;font.pixelSize:Theme.secondary }
        CComboBox {
            id:inputDevice;objectName:"audioInputDevice";Layout.fillWidth:true;model:voiceSettings.inputChoices;textRole:"label";valueRole:"id";Accessible.name:"Microphone"
            currentIndex:Math.max(0,voiceSettings.inputChoices.findIndex(item=>item.id===voiceSettings.audioChoice.input))
            onActivated:App.rpc("settings.update",{audio:{input:currentValue}})
        }
        CText { text:"Speaker";color:Theme.muted;font.pixelSize:Theme.secondary }
        CComboBox {
            id:outputDevice;objectName:"audioOutputDevice";Layout.fillWidth:true;model:voiceSettings.outputChoices;textRole:"label";valueRole:"id";Accessible.name:"Speaker"
            currentIndex:Math.max(0,voiceSettings.outputChoices.findIndex(item=>item.id===voiceSettings.audioChoice.output))
            onActivated:App.rpc("settings.update",{audio:{output:currentValue}})
        }
    }
    RowLayout {
        Layout.fillWidth:true
        CText { objectName:"audioDevicesStatus";Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.caption;color:voiceSettings.devicesError||voiceSettings.audioDevices.error?Theme.amber:Theme.muted
            text:voiceSettings.devicesError||voiceSettings.audioDevices.error||(voiceSettings.audioDevices.backend?(voiceSettings.audioDevices.backend==="pipewire"?"Devices from PipeWire":"Devices from ALSA")+" · "+(voiceSettings.audioDevices.inputs||[]).length+" microphones, "+(voiceSettings.audioDevices.outputs||[]).length+" speakers. A chosen speaker plays through PAL’s own player.":"Listing devices…") }
        CButton { objectName:"audioDevicesRefresh";text:"Refresh";enabled:voiceSettings.devicesRequest<0;onClicked:voiceSettings.loadDevices() }
    }
    Connections { target:App;function onResult(id,value){if(id!==voiceSettings.devicesRequest)return;voiceSettings.devicesRequest=-1;if(value?.error)voiceSettings.devicesError=String(value.error);else voiceSettings.audioDevices=value} }
    Connections {
        target:App
        function onStateChanged(){
            if(!App.connected)voiceSettings.loaded=false
            else if(voiceSettings.available&&!voiceSettings.loaded)voiceSettings.refresh()
        }
        function onResult(id,value){
            if(id===voiceSettings.hostedVoicesRequest){voiceSettings.hostedVoicesRequest=-1;voiceSettings.error=value?.error||"";if(!voiceSettings.error)voiceSettings.hostedVoices=value.voices||value.items||[];return}
            if(voiceSettings.tuningRequests[id]){
                const pending=Object.assign({},voiceSettings.tuningRequests);delete pending[id];voiceSettings.tuningRequests=pending
                voiceSettings.error=value?.error||""
                return
            }
            if(id!==voiceSettings.voicesRequest)return
            voiceSettings.voicesRequest=-1
            voiceSettings.error=value?.error||""
            if(!voiceSettings.error)voiceSettings.voices=(value.voices||[]).map(voice=>Object.assign({},voice,{label:voice.id==="kokoro-af_heart"?"Heart · natural feminine":voice.id==="kokoro-af_bella"?"Bella · warm feminine":voice.id}))
        }
    }
}
