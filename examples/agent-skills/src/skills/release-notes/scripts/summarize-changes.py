def run(input, ctx):
    changes = input.get("changes", [])
    return {
        "skill": ctx["skill"]["name"],
        "changeCount": len(changes),
        "summary": "; ".join(changes),
    }
