.pragma library

// Display names shared by every surface that names a provider.
const providerNames = {codex: "Codex", claude: "Claude", ollama: "Ollama", antigravity: "AntiGravity",
    openai: "OpenAI API", anthropic: "Claude API", google: "Google AI API", azure_openai: "Azure OpenAI",
    deepseek: "DeepSeek", mistral: "Mistral AI", xai: "Grok (xAI)", perplexity: "Perplexity",
    openrouter: "OpenRouter", huggingface: "Hugging Face", litellm: "LiteLLM", forge: "TensorBlock Forge",
    edenai: "Eden AI", compatible: "Compatible endpoint"}

function provider(id) {
    const value = String(id || "")
    return providerNames[value] || (value ? value.charAt(0).toUpperCase() + value.slice(1) : "")
}

const researchStates = {
    planning: "Planning", searching: "Searching", reading: "Reading", synthesizing: "Writing",
    cancel_requested: "Cancelling", paused: "Paused", completed: "Complete", partial: "Partial",
    stopped: "Finished early", cancelled: "Cancelled", interrupted: "Interrupted", failed: "Failed"
}
const activeResearchStates = ["planning", "searching", "reading", "synthesizing", "cancel_requested"]

function researchState(state) {
    return researchStates[state] || state || "Saved"
}

function researchActive(state) {
    return activeResearchStates.includes(state)
}
