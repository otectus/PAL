import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Usage & budgets: one ledger for this desktop and every phone (broker/usage.ts). Counts are what
// providers reported; estimates and unknowns are labelled as such, and costs come only from prices you enter.
ColumnLayout {
    id:usage
    objectName:"usageSettings"
    Layout.fillWidth:true;spacing:Theme.space4
    property var summary:({})
    property var policy:({})
    property int days:30
    property string error:""
    property string saved:""
    RpcClient { id:rpc }
    function reload(){
        rpc.call("usage.summary",{days:usage.days},value=>{if(value.error)usage.error=value.error;else{usage.summary=value;usage.policy=value.policy||({});usage.error=""}})
    }
    function money(value){return value===null||value===undefined?"—":Number(value).toFixed(2)+" "+(usage.summary.currency||"")}
    function priceLines(){const prices=usage.policy.prices||({});return Object.keys(prices).map(key=>key+" "+prices[key].input+" "+prices[key].output+(prices[key].image!==undefined?" "+prices[key].image:"")).join("\n")}
    function amount(text,label,emptyValue){
        const source=text.trim()
        if(source==="")return {ok:true,value:emptyValue}
        const value=Number(source)
        if(!Number.isFinite(value)||value<0||value>10000000)return {ok:false,error:label+" must be an amount from 0 to 10,000,000."}
        return {ok:true,value:value}
    }
    function parsedPrices(){
        const table={},lines=prices.text.split("\n")
        for(let index=0;index<lines.length;++index){
            const line=lines[index].trim();if(!line)continue
            const parts=line.split(/\s+/),label="Price line "+(index+1)
            if(parts.length!==3&&parts.length!==4)return {ok:false,error:label+" needs provider:model, input price, output price, and optionally an image price."}
            if(!/^[a-z]+:[^\s]{1,200}$/.test(parts[0]))return {ok:false,error:label+" needs a provider:model name, such as openai:gpt-4.1 or openai:*."}
            const values=parts.slice(1).map(Number)
            if(values.some(value=>!Number.isFinite(value)||value<0))return {ok:false,error:label+" contains an invalid price. Use amounts of 0 or more."}
            table[parts[0]]={input:values[0],output:values[1]};if(values.length===3)table[parts[0]].image=values[2]
        }
        return {ok:true,value:table}
    }
    function savePolicy(){
        usage.error="";usage.saved=""
        const code=currency.text.trim().toUpperCase()
        if(!/^[A-Z]{3}$/.test(code)){usage.error="Currency must be a three-letter code, such as USD.";currency.forceActiveFocus();return}
        const currentLimit=usage.policy.monthlyLimit===undefined?null:usage.policy.monthlyLimit
        if(limit.text.trim()===""&&currentLimit!==null){usage.error="The saved monthly limit is still active. Enter an amount, or use Remove monthly limit.";limit.forceActiveFocus();return}
        const monthly=usage.amount(limit.text,"Monthly limit",null),warning=usage.amount(warn.text,"Warning amount",null),table=usage.parsedPrices()
        const invalid=!monthly.ok?monthly:!warning.ok?warning:!table.ok?table:null
        if(invalid){usage.error=invalid.error;return}
        rpc.call("usage.setPolicy",{expectedRevision:usage.policy.revision||"0",currency:code,monthlyLimit:monthly.value,warnAt:warning.value,prices:table.value},value=>{if(value.error)usage.error=value.error;else{usage.saved="Saved budget and prices.";usage.reload()}})
    }
    onVisibleChanged:if(visible)reload()
    Component.onCompleted:reload()
    CSection {
        title:"Usage"
        description:"Requests from every conversation, on this desktop and from your phones. Provider-reported counts are exact; others say estimated or unknown. Codex and Claude Code turns use those tools’ own plans and are counted, not priced."
        Flow {
            Layout.fillWidth:true;spacing:Theme.space2
            Repeater { model:[7,30,90]
                CButton { required property int modelData;text:modelData+" days";primary:usage.days===modelData;quiet:usage.days!==modelData;onClicked:{usage.days=modelData;usage.reload()} } }
        }
        CText { objectName:"usageTotals";Layout.fillWidth:true;wrapMode:Text.Wrap
            text:usage.summary.totals?usage.summary.totals.calls+" requests · "+usage.summary.totals.inputTokens+" input and "+usage.summary.totals.outputTokens+" output tokens reported"+(usage.summary.totals.images?" · "+usage.summary.totals.images+" images":"")
                +"\nPriced cost: "+usage.money(usage.summary.totals.cost)+(usage.summary.totals.unpriced?" (+"+usage.summary.totals.unpriced+" unpriced)":"")
                +"\nReported "+usage.summary.totals.reported+" · estimated "+usage.summary.totals.estimated+" · unknown "+usage.summary.totals.unknown+" · subscription "+usage.summary.totals.subscription:"Loading…" }
        Repeater { model:usage.summary.warnings||[]
            CText { required property string modelData;text:modelData;color:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true } }
        CText { text:"By provider and model";font.weight:Font.DemiBold }
        Repeater { model:(usage.summary.byProvider||[]).slice(0,12)
            CText { required property var modelData;Layout.fillWidth:true;elide:Text.ElideRight;font.pixelSize:Theme.secondary
                text:modelData.key+" · "+modelData.calls+" · "+modelData.inputTokens+"/"+modelData.outputTokens+" tokens · "+(modelData.priced?usage.money(modelData.cost):"unpriced") } }
        CText { text:"By project";font.weight:Font.DemiBold }
        Repeater { model:(usage.summary.byProject||[]).slice(0,12)
            CText { required property var modelData;Layout.fillWidth:true;elide:Text.ElideMiddle;font.pixelSize:Theme.secondary
                text:modelData.key+" · "+modelData.calls+" requests · "+(modelData.priced?usage.money(modelData.cost):"unpriced") } }
        CText { visible:!!usage.error;text:usage.error;color:Theme.danger;font.pixelSize:Theme.caption }
    }
    CSection {
        title:"Budget"
        description:"PAL stops sending paid API requests once this month’s priced use reaches your limit. It is PAL’s own stop, not a provider billing cap, and it cannot recall a request already sent."
        CText { text:usage.summary.month?"This month: "+usage.money(usage.summary.month.spent)+(usage.summary.month.reached?" · limit reached":""):"";font.pixelSize:Theme.secondary }
        GridLayout { Layout.fillWidth:true;columns:3
            CText { text:"Monthly limit";color:Theme.muted;font.pixelSize:Theme.caption }
            CText { text:"Warn at";color:Theme.muted;font.pixelSize:Theme.caption }
            CText { text:"Currency";color:Theme.muted;font.pixelSize:Theme.caption }
            CField { id:limit;objectName:"usageMonthlyLimit";Layout.fillWidth:true;placeholderText:"No limit saved";text:usage.policy.monthlyLimit===null||usage.policy.monthlyLimit===undefined?"":String(usage.policy.monthlyLimit);Accessible.name:"Monthly limit in "+(currency.text||"USD") }
            CField { id:warn;Layout.fillWidth:true;placeholderText:"No warning";text:usage.policy.warnAt===null||usage.policy.warnAt===undefined?"":String(usage.policy.warnAt);Accessible.name:"Warning amount in "+(currency.text||"USD") }
            CField { id:currency;Layout.preferredWidth:Theme.fieldShort;text:usage.policy.currency||"USD";maximumLength:3;Accessible.name:"Three-letter currency code" }
        }
        CText { text:"Token prices in "+(currency.text.trim().toUpperCase()||"currency")+" per million tokens. One line: provider:model input output [per image]. Use provider:* for every model of a provider.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CTextArea { id:prices;objectName:"usagePrices";Layout.fillWidth:true;Layout.preferredHeight:Theme.editorMedium;text:usage.priceLines();font.family:Theme.mono;font.pixelSize:Theme.caption;placeholderText:"openai:gpt-4.1 2 8\nanthropic:* 3 15";Accessible.name:"Prices per million tokens" }
        Flow { Layout.fillWidth:true;spacing:Theme.space2
            CButton { objectName:"saveUsagePolicy";text:"Save budget and prices";primary:true;onClicked:usage.savePolicy() }
            CButton { objectName:"removeUsageLimit";visible:usage.policy.monthlyLimit!==null&&usage.policy.monthlyLimit!==undefined;text:"Remove monthly limit…";danger:true;onClicked:removeLimit.open() }
        }
        CText { objectName:"usagePolicyError";visible:!!usage.error;text:usage.error;color:Theme.danger;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { visible:!!usage.saved;text:usage.saved;color:Theme.success;font.pixelSize:Theme.caption }
    }
    CDialog {
        id:removeLimit;accessibleTitle:"Remove monthly limit"
        CText { text:"Remove the monthly stop?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Paid API requests will no longer stop at "+usage.money(usage.policy.monthlyLimit)+". Prices and the warning amount stay unchanged.";wrapMode:Text.Wrap;Layout.fillWidth:true;color:Theme.amber }
        RowLayout { Layout.fillWidth:true
            CButton { text:"Keep limit";Layout.fillWidth:true;onClicked:removeLimit.close() }
            CButton { text:"Remove monthly limit";danger:true;Layout.fillWidth:true;onClicked:{usage.error="";rpc.call("usage.setPolicy",{expectedRevision:usage.policy.revision||"0",monthlyLimit:null},value=>{if(value.error)usage.error=value.error;else{usage.saved="Monthly limit removed.";usage.reload()}});removeLimit.close()} }
        }
    }
}
