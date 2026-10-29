"""Chat model providers for the in-app agent.

Space settings choose platform (a server env key), a space credential for
Anthropic, OpenAI, or Gemini, or a local-llm-server generate endpoint.
Secrets stay in the credential store or the process environment. This module
never writes them.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Iterator

from . import chat_store, credentials

_DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-4-5",
    "openai": "gpt-4.1",
    "gemini": "gemini-3.8-flash",
    "openai_compatible": "gpt-4.1",
}


def platform_configured() -> bool:
    return bool((os.environ.get("PONA_FLOW_CHAT_API_KEY") or "").strip())


def resolve_model(space_id: str) -> tuple[dict[str, Any], str]:
    """Return ``(request config, api key)`` for this space, or raise ValueError."""
    cfg = chat_store.get_chat_model(space_id)
    provider = cfg["provider"]
    if provider == "platform":
        key = (os.environ.get("PONA_FLOW_CHAT_API_KEY") or "").strip()
        if not key:
            raise ValueError(
                "Chat model is not configured. A space admin can set it in classic "
                "mode, under space settings."
            )
        upstream = (os.environ.get("PONA_FLOW_CHAT_PROVIDER") or "openai").strip().lower()
        if upstream not in ("openai", "anthropic", "gemini", "openai_compatible"):
            upstream = "openai"
        model = cfg["model"] or (os.environ.get("PONA_FLOW_CHAT_MODEL") or "").strip()
        model = model or _DEFAULT_MODELS.get(upstream, "gpt-4.1")
        return (
            {
                "provider": upstream,
                "model": model,
                "base_url": (os.environ.get("PONA_FLOW_CHAT_BASE_URL") or "").strip(),
                "max_rounds": cfg["max_rounds"],
            },
            key,
        )
    if provider == "local_llm":
        config_id = cfg["local_llm_config_id"]
        if not config_id:
            raise ValueError(
                "Local chat needs a local-llm-server config id. A space admin can "
                "set it in classic mode, under space settings."
            )
        return (
            {
                "provider": "local_llm",
                "model": config_id,
                "base_url": cfg["local_llm_base_url"] or "http://127.0.0.1:8000",
                "config_id": config_id,
                "max_rounds": cfg["max_rounds"],
            },
            "",
        )
    name = cfg["credential_name"]
    if not name:
        raise ValueError(
            f"The {provider} chat model needs a space credential. A space admin can "
            "set it in classic mode, under space settings."
        )
    key = credentials.resolve(space_id, name)
    if not key:
        raise ValueError(
            f"Credential {name} has no value. A space admin can set it in classic "
            "mode, under space settings."
        )
    model = cfg["model"] or _DEFAULT_MODELS.get(provider, "")
    return (
        {"provider": provider, "model": model, "base_url": "", "max_rounds": cfg["max_rounds"]},
        key,
    )


def complete(
    model_cfg: dict[str, Any],
    api_key: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> Iterator[dict[str, Any]]:
    """Yield ``text`` deltas and completed ``tool_call`` events."""
    provider = model_cfg.get("provider")
    if provider in ("openai", "openai_compatible"):
        yield from _openai(model_cfg, api_key, messages, tools)
        return
    if provider == "anthropic":
        yield from _anthropic(model_cfg, api_key, messages, tools)
        return
    if provider == "gemini":
        yield from _chunk_text_and_calls(_gemini(model_cfg, api_key, messages, tools))
        return
    if provider == "local_llm":
        yield from _chunk_text_and_calls(_local(model_cfg, messages, tools))
        return
    raise ValueError(f"Unsupported chat provider {provider!r}")


def _chunk_text_and_calls(parsed: dict[str, Any]) -> Iterator[dict[str, Any]]:
    text = str(parsed.get("text") or "")
    step = 48
    for index in range(0, len(text), step):
        yield {"type": "text", "delta": text[index : index + step]}
    for call in parsed.get("tool_calls") or []:
        event: dict[str, Any] = {
            "type": "tool_call",
            "id": str(call.get("id") or ""),
            "name": str(call.get("name") or ""),
            "arguments": call.get("arguments") if isinstance(call.get("arguments"), dict) else {},
        }
        signature = call.get("thought_signature")
        if signature:
            event["thought_signature"] = signature
        yield event
    thought = str(parsed.get("thought") or "")
    step = 48
    for index in range(0, len(thought), step):
        yield {"type": "thought", "delta": thought[index : index + step]}


def _post_json(url: str, body: dict[str, Any], headers: dict[str, str], timeout: int = 180) -> bytes:
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Chat model request failed ({exc.code}): {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Chat model request failed: {exc.reason}") from exc


def _openai_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            converted.append({"role": "system", "content": message.get("content") or ""})
        elif role == "user":
            converted.append({"role": "user", "content": message.get("content") or ""})
        elif role == "assistant":
            entry: dict[str, Any] = {
                "role": "assistant",
                "content": message.get("content") or "",
            }
            calls = message.get("tool_calls") or []
            if calls:
                entry["tool_calls"] = [
                    {
                        "id": call.get("id") or f"call_{index}",
                        "type": "function",
                        "function": {
                            "name": call.get("name"),
                            "arguments": json.dumps(call.get("arguments") or {}),
                        },
                    }
                    for index, call in enumerate(calls)
                ]
            converted.append(entry)
        elif role == "tool":
            converted.append(
                {
                    "role": "tool",
                    "tool_call_id": message.get("tool_call_id") or "",
                    "content": message.get("content") or "",
                }
            )
    return converted


def _openai(
    model_cfg: dict[str, Any],
    api_key: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> Iterator[dict[str, Any]]:
    base = (model_cfg.get("base_url") or "https://api.openai.com/v1").rstrip("/")
    body = {
        "model": model_cfg.get("model") or _DEFAULT_MODELS["openai"],
        "messages": _openai_messages(messages),
        "tools": tools,
        "stream": True,
    }
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{base}/chat/completions",
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    calls: dict[int, dict[str, str]] = {}
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                except ValueError:
                    continue
                choice = (event.get("choices") or [{}])[0]
                delta = choice.get("delta") or {}
                text = delta.get("content") or ""
                if text:
                    yield {"type": "text", "delta": text}
                for fragment in delta.get("tool_calls") or []:
                    index = int(fragment.get("index") or 0)
                    slot = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    if fragment.get("id"):
                        slot["id"] = fragment["id"]
                    function = fragment.get("function") or {}
                    if function.get("name"):
                        slot["name"] += function["name"]
                    if function.get("arguments"):
                        slot["arguments"] += function["arguments"]
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Chat model request failed ({exc.code}): {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Chat model request failed: {exc.reason}") from exc
    for index in sorted(calls):
        slot = calls[index]
        try:
            arguments = json.loads(slot["arguments"] or "{}")
        except ValueError:
            arguments = {}
        if not isinstance(arguments, dict):
            arguments = {}
        yield {
            "type": "tool_call",
            "id": slot["id"] or f"call_{index}",
            "name": slot["name"],
            "arguments": arguments,
        }


def _anthropic_messages(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system = ""
    converted: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            system = str(message.get("content") or "")
            continue
        if role == "user":
            converted.append({"role": "user", "content": message.get("content") or ""})
        elif role == "assistant":
            blocks: list[dict[str, Any]] = []
            if message.get("content"):
                blocks.append({"type": "text", "text": message["content"]})
            for call in message.get("tool_calls") or []:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": call.get("id") or "tool",
                        "name": call.get("name"),
                        "input": call.get("arguments") or {},
                    }
                )
            converted.append({"role": "assistant", "content": blocks or ""})
        elif role == "tool":
            converted.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.get("tool_call_id") or "",
                            "content": message.get("content") or "",
                        }
                    ],
                }
            )
    return system, converted


def _anthropic(
    model_cfg: dict[str, Any],
    api_key: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> Iterator[dict[str, Any]]:
    system, converted = _anthropic_messages(messages)
    anthropic_tools = [
        {
            "name": tool["function"]["name"],
            "description": tool["function"].get("description") or "",
            "input_schema": tool["function"].get("parameters") or {"type": "object", "properties": {}},
        }
        for tool in tools
    ]
    body: dict[str, Any] = {
        "model": model_cfg.get("model") or _DEFAULT_MODELS["anthropic"],
        "max_tokens": 4096,
        "system": system,
        "messages": converted,
        "tools": anthropic_tools,
        "stream": True,
    }
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=data,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    blocks: dict[int, dict[str, Any]] = {}
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:].strip())
                except ValueError:
                    continue
                kind = event.get("type")
                if kind == "content_block_start":
                    index = int(event.get("index") or 0)
                    block = event.get("content_block") or {}
                    blocks[index] = {
                        "type": block.get("type"),
                        "id": block.get("id") or "",
                        "name": block.get("name") or "",
                        "text": "",
                        "json": "",
                    }
                elif kind == "content_block_delta":
                    index = int(event.get("index") or 0)
                    slot = blocks.setdefault(
                        index, {"type": "text", "id": "", "name": "", "text": "", "json": ""}
                    )
                    delta = event.get("delta") or {}
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        slot["text"] += delta["text"]
                        yield {"type": "text", "delta": delta["text"]}
                    if delta.get("partial_json"):
                        slot["json"] += delta["partial_json"]
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Chat model request failed ({exc.code}): {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Chat model request failed: {exc.reason}") from exc
    for index in sorted(blocks):
        slot = blocks[index]
        if slot.get("type") != "tool_use":
            continue
        try:
            arguments = json.loads(slot.get("json") or "{}")
        except ValueError:
            arguments = {}
        if not isinstance(arguments, dict):
            arguments = {}
        yield {
            "type": "tool_call",
            "id": slot.get("id") or f"tool_{index}",
            "name": slot.get("name") or "",
            "arguments": arguments,
        }


def _gemini_schema(schema: Any) -> Any:
    """Gemini function parameters are a Schema proto, not JSON Schema.

    ``additionalProperties`` is valid for OpenAI and Anthropic and is rejected
    with a 400 ("Unknown name additionalProperties") by generateContent.
    """
    if isinstance(schema, list):
        return [_gemini_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    return {
        key: _gemini_schema(value)
        for key, value in schema.items()
        if key != "additionalProperties"
    }


def _gemini_declarations(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": tool["function"]["name"],
            "description": tool["function"].get("description") or "",
            "parameters": _gemini_schema(
                tool["function"].get("parameters") or {"type": "object", "properties": {}}
            ),
        }
        for tool in tools
    ]


def _gemini_function_part(call: dict[str, Any]) -> dict[str, Any]:
    """One model part. Gemini 3 rejects a replayed functionCall that drops its signature."""
    function_call: dict[str, Any] = {
        "name": call.get("name"),
        "args": call.get("arguments") or {},
    }
    call_id = str(call.get("id") or "")
    if call_id and not call_id.startswith("gemini_"):
        function_call["id"] = call_id
    part: dict[str, Any] = {"functionCall": function_call}
    signature = call.get("thought_signature")
    if signature:
        part["thoughtSignature"] = signature
    return part


def _gemini_function_response(message: dict[str, Any]) -> dict[str, Any]:
    response: dict[str, Any] = {
        "name": message.get("name") or "tool",
        "response": {"result": message.get("content") or ""},
    }
    call_id = str(message.get("tool_call_id") or "")
    if call_id and not call_id.startswith("gemini_"):
        response["id"] = call_id
    return {"functionResponse": response}


def _gemini_contents(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Conversation contents for generateContent.

    Parallel tool results stay in one user turn, in call order. Splitting them
    into a response per call is the interleaving Gemini rejects.
    """
    contents: list[dict[str, Any]] = []
    system = ""
    index = 0
    while index < len(messages):
        message = messages[index]
        role = message.get("role")
        if role == "system":
            system = str(message.get("content") or "")
            index += 1
            continue
        if role == "tool":
            parts = []
            while index < len(messages) and messages[index].get("role") == "tool":
                parts.append(_gemini_function_response(messages[index]))
                index += 1
            contents.append({"role": "user", "parts": parts})
            continue
        parts = []
        if message.get("content"):
            parts.append({"text": message["content"]})
        for call in message.get("tool_calls") or []:
            parts.append(_gemini_function_part(call))
        if parts:
            contents.append({"role": "model" if role == "assistant" else "user", "parts": parts})
        index += 1
    return system, contents


def _gemini(
    model_cfg: dict[str, Any],
    api_key: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    declarations = _gemini_declarations(tools)
    system, contents = _gemini_contents(messages)
    model = model_cfg.get("model") or _DEFAULT_MODELS["gemini"]
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    body: dict[str, Any] = {
        "contents": contents,
        "tools": [{"functionDeclarations": declarations}],
        "generationConfig": {"thinkingConfig": {"includeThoughts": True}},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    raw = _post_json(url, body, {"Content-Type": "application/json"})
    parsed = json.loads(raw.decode("utf-8"))
    candidate = (parsed.get("candidates") or [{}])[0] or {}
    finish = str(candidate.get("finishReason") or "")
    feedback = parsed.get("promptFeedback") if isinstance(parsed.get("promptFeedback"), dict) else {}
    block = str(feedback.get("blockReason") or "")
    parts = ((candidate.get("content") or {}).get("parts") or [])
    text = ""
    thought = ""
    calls = []
    for index, part in enumerate(parts):
        # Thought parts are the model's scratchpad. The reply is the other text.
        if part.get("text") and part.get("thought"):
            thought += part["text"]
        elif part.get("text"):
            text += part["text"]
        call = part.get("functionCall")
        if isinstance(call, dict):
            args = call.get("args") if isinstance(call.get("args"), dict) else {}
            signature = part.get("thoughtSignature") or part.get("thought_signature") or ""
            recorded: dict[str, Any] = {
                "id": str(call.get("id") or f"gemini_{index}"),
                "name": call.get("name") or "",
                "arguments": args,
            }
            if signature:
                recorded["thought_signature"] = signature
            calls.append(recorded)
    if not text and not calls and not thought:
        reason = block or finish
        if reason and reason not in ("STOP", "MAX_TOKENS"):
            raise RuntimeError(f"Chat model stopped ({reason}).")
    return {"text": text, "tool_calls": calls, "thought": thought}


def _local(
    model_cfg: dict[str, Any],
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    names = [
        {
            "name": tool["function"]["name"],
            "description": tool["function"].get("description") or "",
            "parameters": tool["function"].get("parameters") or {},
        }
        for tool in tools
    ]
    transcript = []
    for message in messages:
        role = message.get("role") or "user"
        content = message.get("content") or ""
        if message.get("tool_calls"):
            content = (content + "\n" + json.dumps(message["tool_calls"])).strip()
        transcript.append(f"{role}: {content}")
    prompt = (
        "Reply with one JSON object and nothing else. "
        'Shape: {"message":"text to the user","tool_calls":[{"name":"...","arguments":{}}]}. '
        "tool_calls may be empty. Tools:\n"
        + json.dumps(names)
        + "\n\nConversation:\n"
        + "\n".join(transcript)
    )
    base = (model_cfg.get("base_url") or "http://127.0.0.1:8000").rstrip("/")
    config_id = model_cfg.get("config_id") or model_cfg.get("model")
    raw = _post_json(
        f"{base}/configs/{config_id}/generate",
        {"prompt": prompt},
        {"Content-Type": "application/json"},
    )
    try:
        body = json.loads(raw.decode("utf-8"))
    except ValueError:
        body = {"response": raw.decode("utf-8", errors="replace")}
    parsed = body.get("parsed") if isinstance(body.get("parsed"), dict) else None
    text = str(body.get("response") or body.get("text") or "")
    if parsed is None:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start : end + 1])
            except ValueError:
                parsed = None
    if not isinstance(parsed, dict):
        return {"text": text, "tool_calls": []}
    calls = []
    for index, call in enumerate(parsed.get("tool_calls") or []):
        if not isinstance(call, dict):
            continue
        arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
        calls.append(
            {
                "id": f"local_{index}",
                "name": str(call.get("name") or ""),
                "arguments": arguments,
            }
        )
    message = parsed.get("message")
    return {"text": message if isinstance(message, str) else text, "tool_calls": calls}
