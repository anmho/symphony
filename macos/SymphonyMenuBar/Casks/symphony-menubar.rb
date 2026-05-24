cask "symphony-menubar" do
  version "0.1.0"
  sha256 :no_check

  arch arm: "aarch64", intel: "x64"

  url "https://github.com/anmho/symphony/releases/download/menubar-v#{version}/SymphonyMenuBar_#{version}_#{arch}.dmg"

  name "Symphony Menu Bar"
  desc "Monitor local Symphony agents and open Linear tickets from the menu bar"
  homepage "https://github.com/anmho/symphony/tree/main/macos/SymphonyMenuBar"

  depends_on macos: ">= :ventura"

  app "SymphonyMenuBar.app"

  zap trash: [
    "~/Library/Preferences/com.anmho.symphony.menubar.plist"
  ]
end
