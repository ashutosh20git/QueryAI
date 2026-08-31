// @ts-nocheck

import { QueryAI } from "@queryai/core"
import { ReadTool } from "@queryai/core/tools"

const queryai = QueryAI.make({})

queryai.tool.add(ReadTool)

queryai.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

queryai.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

queryai.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await queryai.session.create({
  agent: "build",
})

queryai.subscribe((event) => {
  console.log(event)
})

await queryai.session.prompt({
  sessionID,
  text: "hey what is up",
})

await queryai.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await queryai.session.wait()

console.log(await queryai.session.messages(sessionID))
