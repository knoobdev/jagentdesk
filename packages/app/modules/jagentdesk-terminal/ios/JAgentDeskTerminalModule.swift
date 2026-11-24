import ExpoModulesCore

public class JAgentDeskTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JAgentDeskTerminal")

    View(JAgentDeskTerminalView.self) {
      Events("onCellMetrics")

      Prop("frame") { (view: JAgentDeskTerminalView, frame: TerminalFrameRecord) in view.setFrame(frame) }
      Prop("theme") { (view: JAgentDeskTerminalView, theme: TerminalThemeRecord) in view.setTheme(theme) }
      Prop("fontFamily") { (view: JAgentDeskTerminalView, family: String) in view.setFontFamily(family) }
      Prop("fontSize") { (view: JAgentDeskTerminalView, size: Double) in view.setFontSize(size) }
      Prop("customGlyphs") { (view: JAgentDeskTerminalView, glyphs: [TerminalCustomGlyphRecord]) in
        view.setCustomGlyphs(glyphs)
      }

      OnViewDidUpdateProps { (view: JAgentDeskTerminalView) in view.commit() }
    }
  }
}
