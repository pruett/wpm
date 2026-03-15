import { HttpApi } from "@effect/platform"
import { AuthGroup } from "./groups/AuthGroup"
import { TradingGroup } from "./groups/TradingGroup"
import { MarketsGroup } from "./groups/MarketsGroup"
import { WalletGroup } from "./groups/WalletGroup"
import { UserGroup } from "./groups/UserGroup"
import { LeaderboardGroup } from "./groups/LeaderboardGroup"
import { AdminGroup } from "./groups/AdminGroup"
import { OracleGroup } from "./groups/OracleGroup"
import { EventsGroup } from "./groups/EventsGroup"

export class WpmApi extends HttpApi.make("wpm")
  .add(AuthGroup)
  .add(TradingGroup)
  .add(MarketsGroup)
  .add(WalletGroup)
  .add(UserGroup)
  .add(LeaderboardGroup)
  .add(AdminGroup)
  .add(OracleGroup)
  .add(EventsGroup)
{}
