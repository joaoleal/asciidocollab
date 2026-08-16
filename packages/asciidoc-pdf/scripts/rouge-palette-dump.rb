#!/usr/bin/env ruby
# frozen_string_literal: true

# Ask rouge itself for the three things the palette is built from, and print them as JSON.
#
# This runs against the VENDORED gems, not whatever rouge the host happens to have installed: the
# palette must describe the gem the wasm engine is built from, and that is a different version from
# the one in, say, the reference image. `generate-rouge-palette.mjs` locates the gem and passes its
# lib directory in; nothing here searches for one.
#
# Loading rather than parsing is the point. Rouge's token taxonomy is a nested DSL, its theme DSL
# resolves aliases (`Num` is `Literal::Number`) and `if defined?` guards, and its lexer registry is
# written by two different declarations — all things a text parser has to re-implement and can get
# subtly wrong. Running the DSL cannot be subtly wrong: it is the same code the export runs.
#
# Config arrives as JSON on stdin, and JSON goes to stdout, so the JS side owns the output schema.

require 'json'

config = JSON.parse($stdin.read)

$LOAD_PATH.unshift config.fetch('rougeLib')
require 'rouge'

# `Token.cache` is written by `register!` as each token is declared and Ruby hashes keep insertion
# order, so its keys are the taxonomy in declaration order. A token's parent is its qualified name
# minus the last segment, which is how a consumer resolves the style of a token no theme names —
# `Theme.get_own_style` walks exactly that chain.
tokens = Rouge::Token.cache.keys

# Every name a source block can declare that `Rouge::Lexer.find` will resolve. `find` is a lookup in
# the registry that both `tag` and `aliases` write, and the two are indistinguishable to it — `django`
# is an ALIAS of the Jinja lexer, and a document declaring it is highlighted by the export. `require
# 'rouge'` loads every lexer eagerly (`Rouge.load_lexers`), so `all` is the whole registry.
lexers = Rouge::Lexer.all.flat_map { |lexer| [lexer.tag, *lexer.aliases] }.uniq.sort

themes = config.fetch('themes').to_h do |wanted|
  load wanted.fetch('file')
  name = wanted.fetch('name')
  klass = Rouge::Theme.find(name)
  raise "No theme named '#{name}' was registered by #{wanted.fetch('file')}." if klass.nil?

  # `Module#to_s`, not `.name`: rouge's themes override `name` as the DSL that registers them.
  styles = klass.styles.to_h { |token, style| [token.qualname, style] }
  [name, { 'superclass' => klass.superclass.to_s, 'styles' => styles }]
end

puts JSON.generate({ 'tokens' => tokens, 'lexers' => lexers, 'themes' => themes })
