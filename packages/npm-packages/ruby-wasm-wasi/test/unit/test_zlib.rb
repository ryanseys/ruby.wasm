require "test-unit"
require "zlib"

# Zlib's block forms hand each chunk to the block from inside rb_protect. On
# WebAssembly a callback of the wrong function type traps ("function signature
# mismatch") as soon as the output outgrows its first 1 KB buffer.
class TestZlib < Test::Unit::TestCase
  DATA = Random.new(1).bytes(200_000)

  def test_inflate_with_a_block_past_one_buffer
    out = String.new(encoding: Encoding::BINARY)
    z = Zlib::Inflate.new
    out << z.inflate(Zlib.deflate(DATA)) { |chunk| out << chunk }.to_s
    out << z.finish.to_s
    z.close
    assert_equal DATA, out
  end

  def test_deflate_with_a_block_past_one_buffer
    out = String.new(encoding: Encoding::BINARY)
    z = Zlib::Deflate.new
    out << z.deflate(DATA, Zlib::FINISH) { |chunk| out << chunk }.to_s
    z.close
    assert_equal DATA, Zlib.inflate(out)
  end
end
