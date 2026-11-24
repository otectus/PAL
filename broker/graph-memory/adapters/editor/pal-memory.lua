-- Neovim: require this file (for example `dofile("…/pal-memory.lua")`) to tell PAL which document is open, saved or closed.
-- Only the path goes out, to PAL's own socket, and PAL keeps it only inside folders you approved. Text is never sent.
if vim.g.pal_memory_loaded then return end
vim.g.pal_memory_loaded = true

local here = debug.getinfo(1, "S").source:sub(2):match("(.*/)") or "./"
local emitter = vim.env.PAL_MEMORY_EDITOR or (here .. "pal-memory-editor.py")
if vim.fn.executable(emitter) == 0 then return end

-- Seeded from the process and the clock, so two editors never share an identity.
math.randomseed(vim.fn.getpid() + vim.loop.hrtime() % 2147483647)
local session = ("xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx"):gsub("x", function() return ("%x"):format(math.random(0, 15)) end)
local sequence = 0

local function emit(event, path, wait)
  sequence = sequence + 1
  local command = { emitter, "--event", event, "--session-id", session, "--sequence", tostring(sequence), "--editor", "Neovim", "--pid", tostring(vim.fn.getpid()) }
  if path then vim.list_extend(command, { "--path", path }) end
  if vim.env.KITTY_WINDOW_ID then vim.list_extend(command, { "--kitty-window-id", vim.env.KITTY_WINDOW_ID }) end
  if vim.env.KITTY_PID then vim.list_extend(command, { "--kitty-pid", vim.env.KITTY_PID }) end
  local job = vim.fn.jobstart(command, { detach = true })
  if wait and job > 0 then vim.fn.jobwait({ job }, 200) end
end

-- Files only: no terminal, help, quickfix or unnamed buffer has a path to tell.
local function document(buffer)
  if vim.bo[buffer].buftype ~= "" then return nil end
  local name = vim.api.nvim_buf_get_name(buffer)
  if name == "" or name:match("^%a+://") then return nil end
  return vim.fn.fnamemodify(name, ":p")
end

local group = vim.api.nvim_create_augroup("PalMemory", { clear = true })
local function on(events, name)
  vim.api.nvim_create_autocmd(events, { group = group, callback = function(args) local path = document(args.buf); if path then emit(name, path) end end })
end
on({ "BufReadPost", "BufNewFile" }, "document_opened")
on({ "BufEnter", "FocusGained" }, "document_focused")
on({ "BufWritePost" }, "document_saved")
on({ "BufDelete" }, "document_closed")
vim.api.nvim_create_autocmd("VimLeavePre", { group = group, callback = function() emit("editor_closed", nil, true) end })
