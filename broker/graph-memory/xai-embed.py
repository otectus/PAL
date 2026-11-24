"""PINNED protocol bridge for the xAI SDK's general Embedder service."""
import json
import sys


def main():
    from importlib.metadata import version
    if version("xai-sdk") != "1.21.0":
        raise RuntimeError("sdk-version")
    import grpc
    from xai_sdk.proto.v6 import embed_pb2, embed_pb2_grpc
    request = json.loads(sys.stdin.buffer.read(2 * 1024 * 1024))
    with grpc.secure_channel("api.x.ai:443", grpc.ssl_channel_credentials(),
                             options=[("grpc.max_receive_message_length", 8 * 1024 * 1024),
                                      ("grpc.enable_retries", 0)]) as channel:
        stub = embed_pb2_grpc.EmbedderStub(channel)
        result = stub.Embed(embed_pb2.EmbedRequest(
            model=request["model"], encoding_format=embed_pb2.FORMAT_FLOAT,
            input=[embed_pb2.EmbedInput(string=text) for text in request["input"]]),
            metadata=(("authorization", "Bearer " + request["key"]),), timeout=25)
        rows = sorted(result.embeddings, key=lambda row: row.index)
        if len(rows) != len(request["input"]) or any(
                row.index != i or len(row.embeddings) != 1 for i, row in enumerate(rows)):
            raise ValueError("shape")
        json.dump([list(row.embeddings[0].float_array) for row in rows], sys.stdout, allow_nan=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # gRPC error details can contain account data. Only emit a short status code.
        status = getattr(error, "code", lambda: None)()
        sys.stderr.write(getattr(status, "name", "SDK_OR_RESPONSE_INVALID"))
        sys.exit(1)
