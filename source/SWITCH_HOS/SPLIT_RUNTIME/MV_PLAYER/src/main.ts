import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.44.0').catch(reportFatal);

