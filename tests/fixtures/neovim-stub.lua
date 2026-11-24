-- A stand-in for the few Neovim calls pal-memory.lua uses, for a computer without Neovim: each command is printed.
local callbacks, buffers = {}, { [1] = { name = "/work/a.ts", buftype = "" }, [2] = { name = "term://x", buftype = "terminal" }, [3] = { name = "fugitive://x", buftype = "" }, [4] = { name = "", buftype = "" } }
vim = {
  g = {}, env = { KITTY_WINDOW_ID = "4", KITTY_PID = "77" }, loop = { hrtime = function() return os.time() end },
  bo = setmetatable({}, { __index = function(_, id) return buffers[id] end }),
  list_extend = function(list, more) for _, value in ipairs(more) do table.insert(list, value) end return list end,
  fn = { executable = function() return 1 end, getpid = function() return 123 end, fnamemodify = function(name) return name end, jobwait = function() end,
    jobstart = function(command) print(table.concat(command, "\t", 2)) return 1 end },
  api = { nvim_create_augroup = function() return 1 end, nvim_buf_get_name = function(id) return buffers[id].name end,
    nvim_create_autocmd = function(events, options) for _, event in ipairs(type(events) == "table" and events or { events }) do callbacks[event] = options.callback end end },
}
dofile(arg[1])
for id = 1, 4 do callbacks.BufReadPost({ buf = id }) end
callbacks.BufEnter({ buf = 1 }); callbacks.BufWritePost({ buf = 1 }); callbacks.BufDelete({ buf = 1 }); callbacks.VimLeavePre({ buf = 1 })
dofile(arg[1]) -- loading it twice changes nothing
