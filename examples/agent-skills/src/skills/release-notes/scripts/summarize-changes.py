import json

with open("/input.json") as input_file:
    input = json.load(input_file)

with open("/context.json") as context_file:
    ctx = json.load(context_file)

changes = input.get("changes", [])
print(
    json.dumps(
        {
            "skill": ctx["skill"]["name"],
            "changeCount": len(changes),
            "summary": "; ".join(changes),
        }
    )
)
