"""Private NDJSON worker for PAL's LiteLLM bridge. Provider credentials never enter env."""
import asyncio
import importlib.metadata
import json
import sys

try:
    import litellm
except Exception as exc:
    print(json.dumps({"type": "ready", "ok": False, "error": "LiteLLM is not installed: " + str(exc)[:300]}), flush=True)
    raise SystemExit(0)

try:
    VERSION = importlib.metadata.version("litellm")
except importlib.metadata.PackageNotFoundError:
    VERSION = "unknown"
# Reasoning a provider needs back with the tool calls it led to, in LiteLLM's documented form.
STATE = ("reasoning_content", "thinking_blocks")
tasks = {}


def native(message):
    """PAL's message in the form LiteLLM documents."""
    role = message["role"]
    content = message.get("content") or ""
    images = message.get("images") or []
    out = {"role": role, "content": content}
    if role == "user" and images:
        out["content"] = [{"type": "text", "text": content}] + [{"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (image["mime"], image["data"])}} for image in images]
    if role == "tool":
        out["tool_call_id"] = message.get("toolCallId") or ""
    elif message.get("name"):
        out["name"] = message["name"]
    calls = message.get("toolCalls") or []
    if role == "assistant" and calls:
        out["tool_calls"] = [{"id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": call["arguments"]}} for call in calls]
        out["content"] = content or None
    state = message.get("state")
    if role == "assistant" and isinstance(state, dict):
        for key in STATE:
            if state.get(key):
                out[key] = state[key]
    return out


def plain(value):
    """Provider objects as plain data; anything that is not data stays here."""
    try:
        return json.loads(json.dumps(value, default=lambda item: item.model_dump()))
    except (AttributeError, TypeError, ValueError):
        return None


def emit(value):
    print(json.dumps(value, separators=(",", ":"), ensure_ascii=False), flush=True)

async def execute(message):
    request_id = message["id"]
    try:
        operation = message.get("operation")
        payload = message.get("payload") or {}
        auth = message.get("auth") or {}
        common = {"model": payload["model"], "api_key": auth.get("apiKey")}
        if auth.get("baseUrl"):
            common["api_base"] = auth["baseUrl"]
        if operation == "chat":
            args = dict(common, messages=[native(item) for item in payload["messages"]], stream=False)
            if payload.get("temperature") is not None: args["temperature"] = payload["temperature"]
            if payload.get("maxOutputTokens") is not None: args["max_tokens"] = payload["maxOutputTokens"]
            if payload.get("responseFormat") == "json": args["response_format"] = {"type": "json_object"}
            if payload.get("tools"):
                args["tools"] = [{"type": "function", "function": tool} for tool in payload["tools"]]
            if payload.get("stream") is True:
                chunks = []
                async for chunk in await litellm.acompletion(**dict(args, stream=True, stream_options={"include_usage": True})):
                    chunks.append(chunk)
                    for part in (getattr(chunk, "choices", None) or [])[:1]:
                        text = getattr(getattr(part, "delta", None), "content", None)
                        if isinstance(text, str) and text:
                            emit({"type": "delta", "id": request_id, "text": text})
                answer = litellm.stream_chunk_builder(chunks, messages=args["messages"])
                if answer is None or not getattr(answer, "choices", None):
                    raise ValueError("The reply ended before it was complete")
            else:
                answer = await litellm.acompletion(**args)
            choice = answer.choices[0]
            usage = getattr(answer, "usage", None)
            raw_calls = getattr(choice.message, "tool_calls", None) or []
            calls = []
            for call in raw_calls:
                function = getattr(call, "function", None)
                calls.append({"id": getattr(call, "id", ""), "name": getattr(function, "name", ""), "arguments": getattr(function, "arguments", "{}")})
            emit({"type": "result", "id": request_id, "value": {
                "text": choice.message.content or "", "finishReason": getattr(choice, "finish_reason", None),
                "model": getattr(answer, "model", payload["model"]),
                "toolCalls": calls,
                "state": {key: value for key, value in ((key, plain(getattr(choice.message, key, None))) for key in STATE) if value},
                "usage": plain(usage)
            }})
        elif operation == "embeddings":
            args = dict(common, input=payload["input"])
            if payload.get("dimensions") is not None: args["dimensions"] = payload["dimensions"]
            answer = await litellm.aembedding(**args)
            rows = sorted(answer.data, key=lambda row: row["index"] if isinstance(row, dict) else row.index)
            vectors = [row["embedding"] if isinstance(row, dict) else row.embedding for row in rows]
            emit({"type": "result", "id": request_id, "value": {"model": getattr(answer, "model", payload["model"]), "vectors": vectors}})
        else:
            raise ValueError("Unknown bridge operation")
    except asyncio.CancelledError:
        emit({"type": "error", "id": request_id, "error": "Bridge request cancelled"})
    except Exception as exc:
        # Do not serialize provider exception objects: some include request headers.
        detail = type(exc).__name__ + ": " + str(exc)
        if "No module named 'mcp'" in detail:
            detail = "This LiteLLM needs its mcp part before it can offer tools: install litellm[mcp], or let PAL keep LiteLLM"
        for secret in (auth.get("apiKey"),):
            if secret: detail = detail.replace(str(secret), "[redacted]")
        emit({"type": "error", "id": request_id, "error": detail[:1000]})
    finally:
        tasks.pop(request_id, None)

async def main():
    emit({"type": "ready", "ok": True, "version": VERSION})
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line: break
        try: message = json.loads(line)
        except Exception: continue
        if message.get("operation") == "cancel":
            task = tasks.get(message.get("id"))
            if task: task.cancel()
            continue
        request_id = message.get("id")
        if not isinstance(request_id, str) or request_id in tasks: continue
        tasks[request_id] = asyncio.create_task(execute(message))
    for task in list(tasks.values()): task.cancel()

asyncio.run(main())
