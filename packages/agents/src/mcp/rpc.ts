// aim is to have an mcp transport which can work over cloudflare rpc service binding
// caveats: body must be serializable, no streams I dont think.
// no auth needed as its internal to the worker
// usage: mcp.serve('/mcp', { transport: 'rpc', binding: 'MCP_RPC', functionName: 'handle' })

//simular to callable functions in the sdk

// rpc client transport

// rpc server transport

// implement this in examples/rpc-transport/src/server.ts
// you will have to build the agents sdk package and then run npm i in the example folder to pick up changes

// the aim is to declare.

//  mcp.addMCPServer({
//    binding: 'MCP_RPC',
//    functionName: 'handle'
//  })

// its tough to work out the developer experience since all the other transports have a url and this wont. maybe we overload the addMCPServer method to take either a url or a binding+functionName?
// there will be no authentication since its internal to the worker
// we should look at what constitutes a transport.
