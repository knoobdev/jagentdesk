package sh.jagentdesk.terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class JAgentDeskTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("JAgentDeskTerminal")

    View(JAgentDeskTerminalView::class) {
      Events("onCellMetrics")

      Prop("frame") { view: JAgentDeskTerminalView, frame: TerminalFrameRecord -> view.setFrame(frame) }
      Prop("theme") { view: JAgentDeskTerminalView, theme: TerminalThemeRecord -> view.setTheme(theme) }
      Prop("fontFamily") { view: JAgentDeskTerminalView, family: String -> view.setFontFamily(family) }
      Prop("fontSize") { view: JAgentDeskTerminalView, size: Double -> view.setFontSize(size) }
      Prop("customGlyphs") { view: JAgentDeskTerminalView, glyphs: List<TerminalCustomGlyphRecord> ->
        view.setCustomGlyphs(glyphs)
      }

      OnViewDidUpdateProps { view: JAgentDeskTerminalView -> view.commit() }
    }
  }
}
